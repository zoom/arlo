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
  const stored = store.appendSegment('M1', {
    ...segment(1, 'x'.repeat(5000)), speakerLabel: 'n'.repeat(300), extra: 'dropped', __proto__: { polluted: true },
  });

  assert.deepEqual(Object.keys(stored).sort(), ['seqNo', 'speakerId', 'speakerLabel', 'tEndMs', 'tStartMs', 'text']);
  assert.equal(stored.text.length, 4000);
  assert.equal(stored.speakerLabel.length, 200);
  assert.equal({}.polluted, undefined);
});

test('a segment without text is refused; a missing sequence number is assigned', () => {
  const store = createMemoryMeetingStore();
  assert.equal(store.appendSegment('M1', { seqNo: 1 }), null);
  assert.equal(store.appendSegment('M1', null), null);
  assert.equal(store.appendSegment('', segment(1)), null);
  assert.equal(store.has('M1'), false);

  assert.equal(store.appendSegment('M1', { text: 'no number' }).seqNo, 1);
  assert.equal(store.appendSegment('M1', { text: 'still none' }).seqNo, 2);
});

test('returned lists are copies: callers cannot change what is stored', () => {
  const store = createMemoryMeetingStore();
  store.appendSegment('M1', segment(1));
  store.listSegments('M1').push({ text: 'injected' });
  store.listSegments('M1')[0].text = 'changed';
  assert.deepEqual(store.listSegments('M1').map((s) => s.text), ['line 1']);
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

test('the oldest meeting is dropped past the meeting limit', () => {
  const store = createMemoryMeetingStore({ maxMeetings: 2 });
  store.appendSegment('M1', segment(1));
  store.appendSegment('M2', segment(1));
  store.appendSegment('M3', segment(1));
  assert.equal(store.has('M1'), false);
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
