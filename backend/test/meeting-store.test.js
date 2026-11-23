// The per-meeting memory: what the server holds while a meeting runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');

const segment = (seqNo, text = `line ${seqNo}`) => ({
  seqNo, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: 1000 * seqNo, tEndMs: 1000 * seqNo,
});

test('segments are kept per meeting, in order', () => {
  const store = createMemoryMeetingStore();
  store.appendSegment('M1', segment(1));
  store.appendSegment('M1', segment(2));
  store.appendSegment('M2', segment(1, 'other meeting'));

  assert.deepEqual(store.listSegments('M1').map((s) => s.text), ['line 1', 'line 2']);
  assert.deepEqual(store.listSegments('M2').map((s) => s.text), ['other meeting']);
  assert.deepEqual(store.listSegments('unknown'), []);
});

test('a stored segment has only the known fields, with long values cut', () => {
  const store = createMemoryMeetingStore();
  // As it arrives over HTTP: JSON.parse makes "__proto__" and "constructor" own keys
  const raw = JSON.parse(JSON.stringify({ ...segment(1, 'x'.repeat(5000)), speakerLabel: 'n'.repeat(300), extra: 'dropped' })
    .replace('"extra"', '"__proto__":{"polluted":true},"constructor":"c","extra"'));
  const stored = store.appendSegment('M1', raw);

  assert.deepEqual(Object.keys(stored).sort(), ['seqNo', 'speakerId', 'speakerLabel', 'tEndMs', 'tStartMs', 'text']);
  assert.equal(Object.getPrototypeOf(stored), Object.prototype);
  assert.equal(stored.polluted, undefined);
  assert.equal(stored.text.length, 4000);
  assert.equal(stored.speakerLabel.length, 200);
  assert.deepEqual(store.listSegments('M1')[0], stored);
});

test('a cut value is a copy, so an oversized original is not kept in memory', () => {
  const store = createMemoryMeetingStore();
  const cut = store.appendSegment('M1', segment(1, `${'x'.repeat(3999)}\u{1F600}${'y'.repeat(100000)}`)).text;
  // Cutting in the middle of an emoji must not leave half a character behind
  assert.equal(/[\uD800-\uDBFF]$/.test(cut), false);
  assert.ok(cut.length <= 4000);
  assert.equal(store.appendEvent('M1', { eventType: 'e'.repeat(500) }).eventType.length, 50);
});

test('the store numbers the lines itself, whatever number a line arrives with', () => {
  // The number a line arrives with is its stream's own count. A meeting can
  // have several streams and the stored one can change, so those counts can
  // repeat, jump or go backwards; the store's numbers never do.
  const store = createMemoryMeetingStore();
  const numbers = [5, 1, 1, 40, Number.MAX_SAFE_INTEGER, 1e308, -5, 1.5, '7', NaN, undefined]
    .map((seqNo) => store.appendSegment('M1', { text: 'line', seqNo }).seqNo);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(store.appendSegment('M2', { text: 'another meeting', seqNo: 9 }).seqNo, 1);
});

test('times that make no sense are replaced', () => {
  const store = createMemoryMeetingStore({ now: () => 9000 });
  const stored = store.appendSegment('M1', { text: 'x', tStartMs: 10, tEndMs: -1e300 });
  assert.equal(stored.tStartMs, 10);
  assert.equal(stored.tEndMs, 10);
  assert.equal(store.appendSegment('M1', { text: 'x', tStartMs: -1 }).tStartMs, 9000);
  assert.equal(store.appendEvent('M1', { eventType: 'joined', timestamp: -1 }).timestamp, 9000);
});

test('a segment without text is refused; a missing sequence number is assigned', () => {
  const store = createMemoryMeetingStore();
  assert.equal(store.appendSegment('M1', { seqNo: 1 }), null);
  assert.equal(store.appendSegment('M1', { seqNo: 1, text: '' }), null);
  assert.equal(store.appendSegment('M1', null), null);
  assert.equal(store.appendSegment('', segment(1)), null);
  assert.equal(store.has('M1'), false);

  assert.equal(store.appendSegment('M1', { text: 'no number' }).seqNo, 1);
  assert.equal(store.appendSegment('M1', { text: 'still none' }).seqNo, 2);
});

test('everything returned is a copy: callers cannot change what is stored', () => {
  const store = createMemoryMeetingStore();
  const appended = store.appendSegment('M1', segment(1));
  appended.text = 'changed through the append result';
  store.listSegments('M1').push({ text: 'injected' });
  store.listSegments('M1')[0].text = 'changed';
  assert.deepEqual(store.listSegments('M1').map((s) => s.text), ['line 1']);

  const event = store.appendEvent('M1', { eventType: 'joined', participantName: 'Ben' });
  event.participantName = 'changed through the append result';
  store.listEvents('M1').push({ eventType: 'injected' });
  store.listEvents('M1')[0].participantName = 'changed';
  assert.deepEqual(store.listEvents('M1').map((e) => e.participantName), ['Ben']);
});

test('timeline events get an id and are kept per meeting', () => {
  const store = createMemoryMeetingStore({ now: () => 5000 });
  const joined = store.appendEvent('M1', { eventType: 'joined', participantName: 'Ben', participantId: '12', timestamp: 4000 });
  const started = store.appendEvent('M1', { eventType: 'transcription_started', participantName: 'Arlo', participantId: null });

  assert.match(joined.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(joined.id, started.id);
  assert.equal(started.timestamp, 5000); // filled in when missing
  assert.deepEqual(store.listEvents('M1').map((e) => e.eventType), ['joined', 'transcription_started']);
  assert.equal(store.appendEvent('M1', { participantName: 'no type' }), null);
});

test('deleting a meeting removes everything held for it', () => {
  const store = createMemoryMeetingStore();
  store.appendSegment('M1', segment(1));
  store.appendEvent('M1', { eventType: 'joined', participantName: 'Ben' });
  store.appendSegment('M2', segment(1));

  assert.equal(store.deleteMeeting('M1'), true);
  assert.equal(store.deleteMeeting('M1'), false);
  assert.deepEqual(store.listSegments('M1'), []);
  assert.deepEqual(store.listEvents('M1'), []);
  assert.equal(store.size(), 1);
});

test('the oldest lines are dropped past the per-meeting limit', () => {
  const store = createMemoryMeetingStore({ maxSegmentsPerMeeting: 3, maxEventsPerMeeting: 2 });
  for (let i = 1; i <= 5; i += 1) store.appendSegment('M1', segment(i));
  for (let i = 1; i <= 4; i += 1) store.appendEvent('M1', { eventType: `e${i}` });

  assert.deepEqual(store.listSegments('M1').map((s) => s.seqNo), [3, 4, 5]);
  assert.deepEqual(store.listEvents('M1').map((e) => e.eventType), ['e3', 'e4']);
});

test('past the meeting limit, the meeting written to longest ago is dropped, not one still in use', () => {
  const store = createMemoryMeetingStore({ maxMeetings: 2 });
  store.appendSegment('LIVE', segment(1));
  store.appendSegment('IDLE', segment(1));
  store.appendSegment('LIVE', segment(2)); // LIVE is older but still being written to
  store.appendSegment('NEW', segment(1));

  assert.equal(store.has('IDLE'), false);
  assert.equal(store.has('LIVE'), true);
  assert.equal(store.has('NEW'), true);
  assert.deepEqual(store.listSegments('LIVE').map((s) => s.seqNo), [1, 2]);
  assert.equal(store.size(), 2);
});

test('sweep deletes meetings older than the age limit', () => {
  const clock = { now: 0 };
  const store = createMemoryMeetingStore({ now: () => clock.now, maxAgeMs: 1000 });
  store.appendSegment('OLD', segment(1));
  clock.now = 600;
  store.appendSegment('NEW', segment(1));
  clock.now = 1100;

  assert.equal(store.sweep(), 1);
  assert.equal(store.has('OLD'), false);
  assert.equal(store.has('NEW'), true);
});
