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
  const lifecycle = createMeetingLifecycle({
    store, schedule, graceMs: 120000, onFlush: (reason, hadData) => flushed.push({ reason, hadData }),
  });
  const speak = (meetingId) => store.appendSegment(meetingId, { seqNo: 1, text: 'hello' });
  return { store, lifecycle, pending, fireAll, flushed, speak };
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
  assert.equal(store.listSegments('M1').length, 1);
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

test('invalid meeting ids are ignored', () => {
  const { lifecycle, pending } = setup();
  lifecycle.panelsChanged('', 0);
  lifecycle.panelsChanged(42, 0);
  lifecycle.streamStatus(null, 'rtms_stopped');
  assert.deepEqual(pending(), []);
  assert.equal(lifecycle.tracked(), 0);
});
