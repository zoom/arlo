// When a meeting's data is deleted from memory.
// The lifecycle module loads src/config, which validates the environment,
// so the test environment has to be set before anything is required.
require('./helpers').setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');
const { createMeetingLifecycle } = require('../src/services/meetingLifecycle');

function setup() {
  const store = createMemoryMeetingStore();
  const timers = [];
  const schedule = (fn, ms) => {
    const timer = { fn, ms, cancelled: false, fired: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  const fireAll = () => pending().forEach((t) => { t.fired = true; t.fn(); });
  const flushed = [];
  const clock = { now: 1_000_000 };
  const lifecycle = createMeetingLifecycle({
    store, schedule, graceMs: 120000, now: () => clock.now, onFlush: (reason, hadData) => flushed.push({ reason, hadData }),
  });
  // What the routes do with a line: ask the lifecycle, then keep it
  const speak = (meetingId, text = 'hello') => (
    lifecycle.dataReceived(meetingId) ? store.appendSegment(meetingId, { text }) : null
  );
  return { store, lifecycle, pending, fireAll, flushed, speak, clock, timers };
}

test('data is kept while the stream runs, with or without a panel open', () => {
  const { store, lifecycle, pending, speak } = setup();
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.panelsChanged('M1', 1);
  lifecycle.panelsChanged('M1', 0);
  assert.deepEqual(pending(), []);
  assert.equal(store.has('M1'), true);
});

test('a stop inside the meeting keeps the data while a panel is connected', () => {
  const { store, lifecycle, pending, speak } = setup();
  lifecycle.panelsChanged('M1', 1);
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_stopped');
  assert.deepEqual(pending(), []);
  assert.equal(store.has('M1'), true);

  // restarting continues the same meeting's data
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1', 'after the restart');
  assert.deepEqual(store.listSegments('M1').map((s) => s.text), ['hello', 'after the restart']);
});

test('Zoom saying the meeting ended flushes at once', () => {
  const { store, lifecycle, flushed, speak } = setup();
  lifecycle.panelsChanged('M1', 2);
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_stopped', { meetingEnded: true });
  assert.equal(store.has('M1'), false);
  assert.deepEqual(flushed, [{ reason: 'meeting_ended', hadData: true }]);
});

test('stream stopped and the last panel gone: flushed after the grace period', () => {
  const { store, lifecycle, pending, fireAll, flushed, speak } = setup();
  lifecycle.panelsChanged('M1', 1);
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_stopped');
  lifecycle.panelsChanged('M1', 0);

  assert.deepEqual(pending().map((t) => t.ms), [120000]);
  assert.equal(store.has('M1'), true);
  fireAll();
  assert.equal(store.has('M1'), false);
  assert.deepEqual(flushed, [{ reason: 'idle', hadData: true }]);
});

test('a panel coming back, or the stream restarting, cancels the pending flush', () => {
  for (const comeBack of [(l) => l.panelsChanged('M1', 1), (l) => l.streamStatus('M1', 'rtms_started')]) {
    const { store, lifecycle, pending, speak } = setup();
    lifecycle.streamStatus('M1', 'rtms_started');
    speak('M1');
    lifecycle.streamStatus('M1', 'rtms_stopped');
    assert.equal(pending().length, 1);
    comeBack(lifecycle);
    assert.deepEqual(pending(), []);
    assert.equal(store.has('M1'), true);
  }
});

test('a failed join counts as not running; pause and interruption change nothing', () => {
  const { lifecycle, pending } = setup();
  lifecycle.streamStatus('M1', 'rtms_started');
  lifecycle.streamStatus('M1', 'rtms_paused');
  lifecycle.streamStatus('M1', 'rtms_interrupted');
  assert.deepEqual(pending(), []);
  lifecycle.streamStatus('M1', 'rtms_reconnected');
  assert.deepEqual(pending(), []);
  lifecycle.streamStatus('M1', 'rtms_failed');
  assert.equal(pending().length, 1);

  // pause and interruption do not make a stopped stream count as running
  lifecycle.streamStatus('M1', 'rtms_paused');
  lifecycle.streamStatus('M1', 'rtms_interrupted');
  assert.equal(pending().length, 1);
});

test('a status word that says nothing about running does not start tracking a meeting', () => {
  const { lifecycle, pending } = setup();
  lifecycle.streamStatus('M1', 'rtms_paused');
  lifecycle.streamStatus('M2', 'bogus');
  lifecycle.streamStatus('M3', undefined);
  assert.equal(lifecycle.tracked(), 0);
  assert.deepEqual(pending(), []);
});

test('"meeting ended" only counts together with a stop', () => {
  const { store, lifecycle, speak } = setup();
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_paused', { meetingEnded: true });
  lifecycle.streamStatus('M1', 'rtms_started', { meetingEnded: true });
  lifecycle.streamStatus('M1', 'rtms_stopped', { meetingEnded: 'true' });
  assert.equal(store.has('M1'), true);
});

test('lines for a meeting nobody announced are tracked: the stream counts as running until told otherwise', () => {
  // e.g. this server restarted mid-meeting and missed "started"
  const { store, lifecycle, pending, fireAll, speak } = setup();
  speak('M1');
  assert.equal(lifecycle.tracked(), 1);
  assert.deepEqual(pending(), []);

  // a panel reconnecting and closing again does not flush a stream that is live
  lifecycle.panelsChanged('M1', 1);
  lifecycle.panelsChanged('M1', 0);
  assert.deepEqual(pending(), []);

  lifecycle.streamStatus('M1', 'rtms_stopped');
  assert.equal(pending().length, 1);
  fireAll();
  assert.equal(store.has('M1'), false);
});

test('a line still in flight after the meeting ended is not kept', () => {
  const { store, lifecycle, speak, clock } = setup();
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_stopped', { meetingEnded: true });

  assert.equal(speak('M1', 'straggler'), null);
  assert.equal(store.has('M1'), false);
  assert.equal(lifecycle.tracked(), 0);

  // long after, the id is forgotten (meeting ids are not reused by Zoom)
  clock.now += 11 * 60 * 1000;
  assert.notEqual(speak('M1', 'much later'), null);
});

test('a line still in flight after an idle flush is not kept either, but a real restart is', () => {
  const { store, lifecycle, fireAll, speak } = setup();
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_stopped');
  fireAll();
  assert.equal(speak('M1', 'straggler'), null);
  assert.equal(store.has('M1'), false);

  lifecycle.streamStatus('M1', 'rtms_started');
  assert.notEqual(speak('M1', 'new stream'), null);
  assert.deepEqual(store.listSegments('M1').map((s) => s.text), ['new stream']);
});

test('lines that keep arriving after a "stopped" hold off the idle flush', () => {
  // The stream restarted but its "started" report never reached this server
  const { store, lifecycle, pending, fireAll, timers, speak } = setup();
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_stopped');
  const firstTimer = timers.at(-1);

  speak('M1', 'still talking');
  assert.equal(firstTimer.cancelled, true);
  assert.equal(pending().length, 1); // a fresh wait, counted from this line
  speak('M1', 'and again');
  assert.equal(pending().length, 1);
  assert.equal(store.listSegments('M1').length, 3);

  fireAll(); // then silence for the whole grace period
  assert.equal(store.has('M1'), false);
});

test('a meeting-ended flush is remembered even when nothing was held', () => {
  const { store, lifecycle, speak } = setup();
  lifecycle.streamStatus('M1', 'rtms_started');
  lifecycle.streamStatus('M1', 'rtms_stopped', { meetingEnded: true });
  assert.equal(speak('M1', 'arrived after the end'), null);
  assert.equal(store.has('M1'), false);
});

test('an idle flush of nothing does not silence a stream that is live', () => {
  // The server restarted mid-meeting: no "started" was heard. A panel opens and
  // closes during a silence, then someone speaks.
  const { store, lifecycle, fireAll, flushed, speak } = setup();
  lifecycle.panelsChanged('M1', 1);
  lifecycle.panelsChanged('M1', 0);
  fireAll();
  assert.deepEqual(flushed, [{ reason: 'idle', hadData: false }]);

  assert.notEqual(speak('M1', 'someone speaks'), null);
  assert.equal(store.listSegments('M1').length, 1);
});

test('a late line after a stop, with a panel still open, is kept and does not mark the stream as running', () => {
  const { store, lifecycle, pending, speak } = setup();
  lifecycle.panelsChanged('M1', 1);
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_stopped');
  assert.notEqual(speak('M1', 'late line'), null);
  assert.equal(store.listSegments('M1').length, 2);

  lifecycle.panelsChanged('M1', 0);
  assert.equal(pending().length, 1); // still counted as stopped
});

test('panels still connected when the meeting ends stay counted', () => {
  const { store, lifecycle, pending, speak } = setup();
  lifecycle.panelsChanged('M1', 2);
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_stopped', { meetingEnded: true });
  assert.equal(store.has('M1'), false);

  // Zoom was wrong, or the same id runs again: with the panels still there, a stop keeps the data
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1', 'second run');
  lifecycle.streamStatus('M1', 'rtms_stopped');
  assert.deepEqual(pending(), []);
  assert.equal(store.has('M1'), true);
});

test('a timer from before a flush cannot flush what came after it', () => {
  const { store, lifecycle, timers, speak } = setup();
  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1');
  lifecycle.streamStatus('M1', 'rtms_stopped'); // idle timer pending
  const stale = timers.at(-1);
  lifecycle.streamStatus('M1', 'rtms_stopped', { meetingEnded: true });
  assert.equal(stale.cancelled, true);

  lifecycle.streamStatus('M1', 'rtms_started');
  speak('M1', 'new meeting data');
  stale.fn(); // even if a cancelled timer somehow ran
  assert.equal(store.has('M1'), true);
});

test('sweep forgets meetings with nothing held and nobody connected, and applies the age limit', () => {
  const clock = { now: 0 };
  const store = createMemoryMeetingStore({ now: () => clock.now, maxAgeMs: 1000 });
  const lifecycle = createMeetingLifecycle({ store, schedule: () => () => {}, now: () => clock.now });

  for (let i = 0; i < 50; i += 1) lifecycle.streamStatus(`NO-DATA-${i}`, 'rtms_started'); // stop never arrives
  lifecycle.streamStatus('OLD', 'rtms_started');
  lifecycle.dataReceived('OLD');
  store.appendSegment('OLD', { text: 'x' });
  lifecycle.panelsChanged('WATCHED', 1);
  assert.equal(lifecycle.tracked(), 52);

  assert.equal(lifecycle.sweep(), 0);
  assert.equal(lifecycle.tracked(), 2); // OLD (has data) and WATCHED (has a panel)

  clock.now = 2000;
  assert.equal(lifecycle.sweep(), 1);
  assert.equal(store.has('OLD'), false);
  assert.equal(lifecycle.tracked(), 1);
});

test('a reporter that throws does not stop the flush', () => {
  const store = createMemoryMeetingStore();
  const lifecycle = createMeetingLifecycle({ store, onFlush: () => { throw new Error('logger down'); } });
  lifecycle.streamStatus('M1', 'rtms_started');
  store.appendSegment('M1', { text: 'x' });
  lifecycle.streamStatus('M1', 'rtms_stopped', { meetingEnded: true });
  assert.equal(store.has('M1'), false);
});

test('a grace period that is not a sane number falls back to two minutes', () => {
  for (const graceMs of [NaN, -5, '10', undefined]) {
    const delays = [];
    const lifecycle = createMeetingLifecycle({
      store: createMemoryMeetingStore(), graceMs, schedule: (fn, ms) => { delays.push(ms); return () => {}; },
    });
    lifecycle.panelsChanged('M1', 1);
    lifecycle.panelsChanged('M1', 0);
    assert.deepEqual(delays, [120000], `graceMs ${graceMs}`);
  }
});

test('a panel that opens and closes with no stream leaves nothing behind', () => {
  const { lifecycle, pending, fireAll, flushed } = setup();
  lifecycle.panelsChanged('M1', 1);
  lifecycle.panelsChanged('M1', 0);
  assert.equal(pending().length, 1);
  fireAll();
  assert.deepEqual(flushed, [{ reason: 'idle', hadData: false }]);
  assert.equal(lifecycle.tracked(), 0);
});

test('a second "no panels" report does not stack a second timer', () => {
  const { lifecycle, pending } = setup();
  lifecycle.panelsChanged('M1', 1);
  lifecycle.panelsChanged('M1', 0);
  lifecycle.panelsChanged('M1', 0);
  assert.equal(pending().length, 1);
});

test('invalid meeting ids and counts are ignored', () => {
  const { store, lifecycle, pending } = setup();
  lifecycle.panelsChanged('', 1);
  lifecycle.panelsChanged(42, 1);
  lifecycle.panelsChanged('x'.repeat(300), 1);
  lifecycle.streamStatus(null, 'rtms_stopped');
  lifecycle.streamStatus('x'.repeat(300), 'rtms_started');
  assert.equal(lifecycle.dataReceived(''), false);
  assert.equal(lifecycle.dataReceived(42), false);
  assert.equal(lifecycle.tracked(), 0);

  store.appendSegment('M1', { text: 'x' });
  lifecycle.panelsChanged('M1', 1);
  for (const bad of [-1, 1.5, '0', null]) lifecycle.panelsChanged('M1', bad);
  assert.deepEqual(pending(), []); // still one panel connected
});

test('whoever keeps other state per meeting is told when a meeting is flushed or no longer tracked', () => {
  const store = createMemoryMeetingStore();
  const forgotten = [];
  const timers = [];
  const lifecycle = createMeetingLifecycle({
    store, schedule: (fn) => { timers.push(fn); return () => {}; }, onForget: (meetingId) => forgotten.push(meetingId),
  });

  // the meeting ended
  lifecycle.streamStatus('ENDED', 'rtms_started');
  store.appendSegment('ENDED', { text: 'x' });
  lifecycle.streamStatus('ENDED', 'rtms_stopped', { meetingEnded: true });
  assert.deepEqual(forgotten, ['ENDED']);

  // idle flush
  lifecycle.streamStatus('IDLE', 'rtms_started');
  lifecycle.streamStatus('IDLE', 'rtms_stopped');
  timers.at(-1)();
  assert.deepEqual(forgotten, ['ENDED', 'IDLE']);

  // a stream that started and was never heard from again: dropped by the sweep
  lifecycle.streamStatus('SILENT', 'rtms_started');
  lifecycle.sweep();
  assert.deepEqual(forgotten, ['ENDED', 'IDLE', 'SILENT']);
  assert.equal(lifecycle.tracked(), 0);
});

test('a stop inside the meeting forgets nothing, and a listener that throws does not stop a flush', () => {
  const store = createMemoryMeetingStore();
  const forgotten = [];
  const lifecycle = createMeetingLifecycle({
    store, schedule: () => () => {}, onForget: (meetingId) => { forgotten.push(meetingId); throw new Error('listener down'); },
  });
  lifecycle.streamStatus('M1', 'rtms_started');
  store.appendSegment('M1', { text: 'x' });
  lifecycle.panelsChanged('M1', 1);
  lifecycle.streamStatus('M1', 'rtms_stopped');
  lifecycle.streamStatus('M1', 'rtms_started');
  assert.deepEqual(forgotten, []);

  lifecycle.streamStatus('M1', 'rtms_stopped', { meetingEnded: true });
  assert.deepEqual(forgotten, ['M1']);
  assert.equal(store.has('M1'), false);
});
