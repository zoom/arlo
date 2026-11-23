// Several Zoom users can each run a stream in one meeting, and every stream
// carries the same speech. This is the record of those streams and the rule
// that stores each line once, whichever streams delivered it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingStreams } = require('../src/services/meetingStreams');

function setup(options) {
  const warnings = [];
  const clock = { now: 1_000_000 };
  const streams = createMeetingStreams({
    log: { warn: (line) => warnings.push(line) }, now: () => clock.now, ...options,
  });
  const after = (seconds) => { clock.now += seconds * 1000; };
  return { streams, warnings, clock, after };
}
const M = 'MEETING-1==';
const line = (text, tStartMs = 1000, speakerId = '7') => ({ speakerId, tStartMs, text });

// --- the streams of a meeting ------------------------------------------------

test('the first stream is the primary one', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });

  assert.equal(streams.isPrimary(M, 's1'), true);
  assert.equal(streams.isPrimary(M, 's2'), false);
  assert.equal(streams.primaryOperator(M), 'op-1');
  assert.equal(streams.anyLive(M), true);
  assert.equal(streams.isLive(M, 's2'), true);
});

test('nothing is known about a meeting no stream was reported for', () => {
  const { streams } = setup();
  assert.equal(streams.isPrimary(M, 's1'), false);
  assert.equal(streams.isLive(M, 's1'), false);
  assert.equal(streams.anyLive(M), false);
  assert.deepEqual(streams.operators(M), []);
  assert.equal(streams.primaryOperator(M), null);
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: false });
  assert.equal(streams.size(), 0);
});

test('an original-host stream that starts later becomes the primary one', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-host', originalHost: true });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3' });

  assert.equal(streams.isPrimary(M, 's2'), true);
  assert.equal(streams.isPrimary(M, 's1'), false);
  assert.equal(streams.primaryOperator(M), 'op-host');
});

test('only the boolean true marks the original host', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2', originalHost: 'true' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3', originalHost: 1 });
  assert.equal(streams.isPrimary(M, 's1'), true);
});

test('when the primary stream stops, the live stream that started first is the primary one', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3' });

  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: true });
  assert.equal(streams.isPrimary(M, 's2'), true);
  assert.equal(streams.isPrimary(M, 's1'), false);
  assert.equal(streams.isLive(M, 's1'), false);
  assert.deepEqual(streams.streamStopped(M, 's2'), { anyLive: true });
  assert.equal(streams.isPrimary(M, 's3'), true);
});

test('another stream stopping does not change the primary one', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  assert.deepEqual(streams.streamStopped(M, 's2'), { anyLive: true });
  assert.equal(streams.isPrimary(M, 's1'), true);
});

test('when the original host\'s stream stops, the stream that started first is the primary one', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-host', originalHost: true });
  streams.streamStopped(M, 's3');
  assert.equal(streams.isPrimary(M, 's1'), true);
});

test('the primary stream does not change while it runs, whoever else starts', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-host', originalHost: true });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2', originalHost: true }); // cannot be, but must not flip
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-host', originalHost: true }); // reported again after a rejoin
  assert.equal(streams.isPrimary(M, 's1'), true);
});

test('after the last stream stopped nothing is live; it stays the primary one until another starts', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStopped(M, 's2');
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: false });
  assert.equal(streams.anyLive(M), false);
  assert.equal(streams.primaryOperator(M), 'op-1');

  // lines of a stopped stream can still be on their way: they are stored
  assert.equal(streams.keepsLine(M, 's1', { line: line('late from s1') }), true);
  assert.equal(streams.keepsLine(M, 's2', { line: line('late from s2') }), true);
  assert.equal(streams.anyLive(M), false); // and do not bring a stopped stream back

  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3' });
  assert.equal(streams.isPrimary(M, 's3'), true);
});

test('operators lists everyone whose stream was seen, the primary stream\'s first, each once', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStarted(M, { streamId: 's3' }); // no operator known
  streams.streamStarted(M, { streamId: 's4', operatorId: 'op-host', originalHost: true });
  assert.deepEqual(streams.operators(M), ['op-host', 'op-1', 'op-2']);

  // someone whose stream stopped is still listed, until the meeting is forgotten
  streams.streamStopped(M, 's4');
  streams.streamStopped(M, 's1');
  assert.deepEqual(streams.operators(M), ['op-2', 'op-1', 'op-host']);
  assert.equal(streams.primaryOperator(M), 'op-2');
});

test('the same user starting again replaces their old stream, as the rtms service does', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-1' });

  assert.equal(streams.isPrimary(M, 's2'), true); // s1 is over, s2 started before s3
  assert.equal(streams.isLive(M, 's1'), false);
  assert.deepEqual(streams.operators(M), ['op-2', 'op-1']);
  streams.streamStopped(M, 's2');
  assert.deepEqual(streams.streamStopped(M, 's3'), { anyLive: false }); // s1 does not count as live
});

test('a user who keeps restarting does not fill the meeting with old streams', () => {
  const { streams, warnings } = setup();
  for (let i = 1; i <= 60; i += 1) streams.streamStarted(M, { streamId: `s${i}`, operatorId: 'op-1' });
  assert.equal(streams.isLive(M, 's60'), true);
  assert.equal(streams.isLive(M, 's59'), false);
  assert.equal(warnings.length, 0);
  assert.equal(streams.keepsLine(M, 's60', { line: line('still stored') }), true);
});

test('a report without a stream id is the only stream of its meeting', () => {
  const { streams } = setup();
  streams.streamStarted(M, { operatorId: 'op-1' });
  assert.equal(streams.isPrimary(M, undefined), true);
  assert.equal(streams.keepsLine(M, undefined, { line: line('one') }), true);
  assert.equal(streams.keepsLine(M, undefined, { line: line('one') }), true); // said again
  assert.equal(streams.primaryOperator(M), 'op-1');
  assert.deepEqual(streams.streamStopped(M, undefined), { anyLive: false });
});

test('a stop without a stream id stops every stream of the meeting', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  assert.deepEqual(streams.streamStopped(M), { anyLive: false });
  assert.deepEqual(streams.operators(M), ['op-1', 'op-2']);
});

test('a stream first heard of through its data counts as started (this server restarted mid-meeting)', () => {
  const { streams } = setup();
  assert.equal(streams.keepsLine(M, 's1', { line: line('one') }), true);
  assert.equal(streams.anyLive(M), true);
  assert.equal(streams.isPrimary(M, 's1'), true);
  // whose stream it is comes with its data
  assert.equal(streams.keepsEvent(M, 's2', {
    event: { eventType: 'joined', participantId: '12' }, operatorId: 'op-host', originalHost: true,
  }), true);
  assert.equal(streams.isLive(M, 's2'), true);
  assert.equal(streams.isPrimary(M, 's2'), true);
  assert.equal(streams.primaryOperator(M), 'op-host');

  // a stream known without an operator gets it from its next line or its late start report
  assert.equal(streams.keepsLine(M, 's1', { line: line('two', 2000), operatorId: 'op-1' }), true);
  assert.deepEqual(streams.operators(M), ['op-host', 'op-1']);
  streams.streamStarted(M, { streamId: 's3' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3' });
  assert.deepEqual(streams.operators(M), ['op-host', 'op-1', 'op-3']);
  // data never replaces another stream of the same user: only a start report does
  assert.equal(streams.keepsLine(M, 's4', { line: line('three', 3000), operatorId: 'op-1' }), true);
  assert.equal(streams.isLive(M, 's1'), true);
});

test('at most 20 streams run in one meeting; more are ignored with one warning', () => {
  const { streams, warnings } = setup();
  for (let i = 1; i <= 25; i += 1) streams.streamStarted(M, { streamId: `s${i}`, operatorId: `op-${i}` });

  assert.equal(streams.operators(M).length, 20);
  assert.equal(streams.isLive(M, 's21'), false);
  assert.equal(streams.keepsLine(M, 's26', { line: line('x') }), false);
  assert.equal(streams.keepsEvent(M, 's26', { event: { eventType: 'joined', participantId: '1' } }), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('op-'), false);
  assert.equal(warnings[0].includes(M), false);
  assert.equal(/s\d/.test(warnings[0]), false);

  // once one of the twenty has stopped there is room: the stopped one's record goes
  streams.streamStopped(M, 's1');
  assert.equal(streams.keepsLine(M, 's26', { line: line('y') }), true);
  assert.equal(streams.isLive(M, 's26'), true);
  assert.equal(streams.hasStopped(M, 's1'), false); // no longer known
  assert.equal(warnings.length, 1);

  // stopping the twenty that run leaves nothing live: the ignored ones were never counted
  for (let i = 2; i <= 20; i += 1) streams.streamStopped(M, `s${i}`);
  assert.deepEqual(streams.streamStopped(M, 's26'), { anyLive: false });
});

test('stopped streams do not use up the meeting\'s room: after twenty of them a new stream is taken', () => {
  const { streams, warnings, after } = setup();
  for (let i = 1; i <= 20; i += 1) {
    streams.streamStarted(M, { streamId: `s${i}`, operatorId: `op-${i}` });
    after(1);
    streams.streamStopped(M, `s${i}`);
  }
  assert.equal(streams.anyLive(M), false);

  // announced by a start report
  streams.streamStarted(M, { streamId: 's21', operatorId: 'op-21' });
  assert.equal(streams.isLive(M, 's21'), true);
  assert.equal(streams.isPrimary(M, 's21'), true);
  assert.equal(streams.keepsLine(M, 's21', { line: line('stored') }), true);
  // or first heard of through its data
  assert.equal(streams.keepsLine(M, 's22', { line: line('stored too', 2000), operatorId: 'op-22' }), true);
  assert.equal(streams.keepsEvent(M, 's23', { event: { eventType: 'joined', participantId: '1' } }), true);
  assert.equal(streams.isLive(M, 's22'), true);
  assert.equal(warnings.length, 0);

  // the streams that stopped longest ago made room; the rest are still known
  for (const gone of ['s1', 's2', 's3']) assert.equal(streams.hasStopped(M, gone), false);
  assert.equal(streams.hasStopped(M, 's4'), true);
  assert.equal(streams.operators(M).length, 19); // 17 stopped with an operator, s21 and s22
  assert.deepEqual(streams.liveOperators(M), ['op-21', 'op-22']);
});

test('room is made first with a stopped stream whose owner has another stream', () => {
  const { streams, after } = setup({ maxStreamsPerMeeting: 3 });
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  after(1);
  streams.streamStopped(M, 's2'); // stopped first, and op-2's only stream
  after(1);
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-1' }); // replaces s1, which is kept as stopped
  assert.deepEqual(streams.operators(M), ['op-1', 'op-2']);

  streams.streamStarted(M, { streamId: 's4', operatorId: 'op-4' });
  assert.equal(streams.isLive(M, 's4'), true);
  assert.equal(streams.hasStopped(M, 's1'), false); // went, though s2 stopped earlier
  assert.equal(streams.hasStopped(M, 's2'), true);
  assert.deepEqual(streams.operators(M), ['op-1', 'op-2', 'op-4']); // nobody stopped being an owner

  // with no such stream left, the one that stopped longest ago goes, and its owner with it
  streams.streamStarted(M, { streamId: 's5', operatorId: 'op-5' });
  assert.equal(streams.hasStopped(M, 's2'), false);
  assert.deepEqual(streams.operators(M), ['op-1', 'op-4', 'op-5']);
  // three run now: a fourth is refused
  streams.streamStarted(M, { streamId: 's6', operatorId: 'op-6' });
  assert.equal(streams.isLive(M, 's6'), false);
});

test('ids that are not sane strings are refused', () => {
  const { streams } = setup();
  for (const bad of [42, '', null, {}, 'x'.repeat(257)]) {
    streams.streamStarted(bad, { streamId: 's1', operatorId: 'op-1' });
    streams.streamStarted(M, { streamId: bad === null ? 7 : bad, operatorId: 'op-1' });
    assert.equal(streams.keepsLine(bad, 's1', { line: line('x') }), false);
  }
  assert.equal(streams.size(), 0);

  streams.streamStarted(M, { streamId: 's1', operatorId: 42 });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'x'.repeat(257) });
  assert.deepEqual(streams.operators(M), []);
  assert.equal(streams.isPrimary(M, 's1'), true);
  assert.equal(streams.keepsLine(M, 42, { line: line('x') }), false);
  assert.equal(streams.keepsEvent(M, 42, { event: { eventType: 'joined', participantId: '1' } }), false);
  assert.deepEqual(streams.streamStopped(M, 42), { anyLive: true }); // a bad id stops nothing
});

test('past the meeting limit the meeting heard from longest ago is dropped', () => {
  const { streams } = setup({ maxMeetings: 2 });
  streams.streamStarted('A', { streamId: 's1' });
  streams.streamStarted('B', { streamId: 's2' });
  streams.streamStarted('A', { streamId: 's3' });
  streams.streamStarted('C', { streamId: 's4' });
  assert.equal(streams.size(), 2);
  assert.equal(streams.anyLive('B'), false);
  assert.equal(streams.anyLive('A'), true);
});

test('when the only stream known was reported without its id, a report that names a stream is about it', () => {
  // An rtms process from before streams were told apart reports no id, while
  // Zoom's own webhooks always name the stream
  const { streams } = setup();
  streams.streamStarted(M, { operatorId: 'op-1' });
  assert.equal(streams.isPrimary(M, 's1'), true);
  assert.equal(streams.keepsLine(M, undefined, { line: line('one') }), true);
  assert.equal(streams.keepsLine(M, 's1', { line: line('one') }), true); // the same stream said it again
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  assert.deepEqual(streams.operators(M), ['op-1']);
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: false });
});

test('a report without a stream id in a meeting whose streams are known by id adds no stream', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, {});
  assert.equal(streams.isPrimary(M, undefined), true);
  assert.equal(streams.isPrimary(M, 's1'), true); // and nothing was added or replaced
  // its lines are one more unnamed stream's: stored unless s1 delivered them already
  assert.equal(streams.keepsLine(M, 's1', { line: line('one') }), true);
  assert.equal(streams.keepsLine(M, undefined, { line: line('one') }), false);
  assert.equal(streams.keepsLine(M, undefined, { line: line('two', 2000) }), true);
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: false });
});

test('stopAll marks every stream of the meeting stopped and keeps who ran them', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStarted('OTHER==', { streamId: 's9', operatorId: 'op-9' });
  streams.stopAll(M);

  assert.equal(streams.anyLive(M), false);
  assert.deepEqual(streams.operators(M), ['op-1', 'op-2']);
  assert.equal(streams.anyLive('OTHER=='), true);
  // the stop reports that follow for each stream change nothing
  assert.deepEqual(streams.streamStopped(M, 's2'), { anyLive: false });
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: false });
  streams.stopAll('UNKNOWN=='); // nothing known: nothing to do
  assert.equal(streams.size(), 2);
});

// --- every line is stored once, whichever streams delivered it ---------------

// Every stream carries the same speech: line n is the same speaker, time and
// words on each of them
const lineNo = (n) => line(`line ${n}`, 50_000 + n * 1000);
/** Feed lines as [streamId, n] pairs; returns the numbers of the lines stored, in order. */
function replay(streams, sequence, stored = []) {
  for (const [streamId, n] of sequence) {
    if (streams.keepsLine(M, streamId, { line: lineNo(n) })) stored.push(n);
  }
  return stored;
}
const sorted = (numbers) => [...numbers].sort((a, b) => a - b);
function started(ids, options) {
  const t = setup(options);
  for (const id of ids) t.streams.streamStarted(M, { streamId: id, operatorId: `op-${id}` });
  return t;
}

test('two streams in step: each line is stored once', () => {
  const { streams } = started(['A', 'B']);
  const stored = replay(streams, [['A', 1], ['B', 1], ['B', 2], ['A', 2], ['A', 3], ['B', 3]]);
  assert.deepEqual(stored, [1, 2, 3]);
});

test('a stream two lines ahead of the other: nothing lost, nothing twice', () => {
  const { streams } = started(['A', 'B']);
  const stored = replay(streams, [
    ['B', 1], ['B', 2], ['A', 1], ['B', 3], ['A', 2], ['B', 4], ['A', 3], ['A', 4],
  ]);
  assert.deepEqual(stored, [1, 2, 3, 4]);
});

test('a stream three lines behind the other: nothing lost, nothing twice', () => {
  const { streams, after } = started(['A', 'B']);
  const stored = replay(streams, [['A', 1], ['A', 2], ['A', 3], ['A', 4]]);
  after(8); // B's copies arrive seconds later
  replay(streams, [['B', 1], ['A', 5], ['B', 2], ['A', 6], ['B', 3], ['B', 4], ['B', 5], ['B', 6]], stored);
  assert.deepEqual(stored, [1, 2, 3, 4, 5, 6]);
});

test('a stream stops while the other is ahead, and its remaining copies never arrive', () => {
  const { streams } = started(['A', 'B']);
  const stored = replay(streams, [['A', 1], ['B', 1], ['B', 2], ['B', 3]]);
  streams.streamStopped(M, 'A'); // A never delivers 2 and 3
  replay(streams, [['B', 4], ['B', 5]], stored);
  assert.deepEqual(stored, [1, 2, 3, 4, 5]);
});

test('a stopped stream\'s lines still on their way are stored, once', () => {
  const { streams } = started(['A', 'B']);
  const stored = replay(streams, [['A', 1], ['B', 1], ['A', 2]]);
  streams.streamStopped(M, 'A');
  replay(streams, [['A', 3], ['B', 2], ['B', 3], ['B', 4]], stored);
  assert.deepEqual(stored, [1, 2, 3, 4]);
  assert.equal(streams.isLive(M, 'A'), false);
});

test('a stream dies without a word and the other goes on for two minutes', () => {
  const { streams, after } = started(['A', 'B']);
  const stored = replay(streams, [['A', 1], ['B', 1], ['A', 2], ['B', 2]]);
  for (let n = 3; n <= 26; n += 1) {
    after(5);
    replay(streams, [['B', n]], stored);
  }
  assert.deepEqual(stored, Array.from({ length: 26 }, (_, i) => i + 1));
});

test('the original host\'s stream starts mid-meeting and delivers nothing for 40 seconds', () => {
  const { streams, after } = started(['A']);
  const stored = replay(streams, [['A', 1]]);
  streams.streamStarted(M, { streamId: 'H', operatorId: 'op-host', originalHost: true });
  assert.equal(streams.isPrimary(M, 'H'), true);
  for (let n = 2; n <= 9; n += 1) {
    after(5);
    replay(streams, [['A', n]], stored);
  }
  // and when it does deliver, its copies are not stored again
  replay(streams, [['H', 9], ['A', 10], ['H', 10]], stored);
  assert.deepEqual(stored, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('a stream that sends only participant events while another sends the lines', () => {
  const { streams, after } = started(['A', 'B']);
  const stored = [];
  for (let n = 1; n <= 8; n += 1) {
    after(6);
    assert.equal(streams.keepsEvent(M, 'A', { event: { eventType: 'joined', participantId: String(n) } }), true);
    replay(streams, [['B', n]], stored);
  }
  assert.deepEqual(stored, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('three streams: each line is stored once, whatever the order', () => {
  const { streams } = started(['A', 'B', 'C']);
  const stored = replay(streams, [
    ['C', 1], ['A', 1], ['B', 1], ['B', 2], ['C', 2], ['C', 3], ['A', 2], ['B', 3], ['A', 3], ['A', 4], ['C', 4], ['B', 4],
  ]);
  assert.deepEqual(stored, [1, 2, 3, 4]);
});

test('the same words twice in a row by one speaker are two lines, and the other stream\'s two copies are dropped', () => {
  const { streams } = started(['A', 'B']);
  const kept = [
    streams.keepsLine(M, 'A', { line: line('Yes.', 1000) }),
    streams.keepsLine(M, 'A', { line: line('Yes.', 2500) }),
    streams.keepsLine(M, 'B', { line: line('Yes.', 1000) }),
    streams.keepsLine(M, 'B', { line: line('Yes.', 2500) }),
  ];
  assert.deepEqual(kept, [true, true, false, false]);
  // also with the copies interleaved, and with nothing to tell them apart but the order
  const next = [
    streams.keepsLine(M, 'A', { line: line('No.', 9000) }),
    streams.keepsLine(M, 'B', { line: line('No.', 9000) }),
    streams.keepsLine(M, 'B', { line: line('No.', 9000) }),
    streams.keepsLine(M, 'A', { line: line('No.', 9000) }),
  ];
  assert.deepEqual(next, [true, false, true, false]);
});

test('the same words from another speaker are another line', () => {
  const { streams } = started(['A', 'B']);
  assert.equal(streams.keepsLine(M, 'A', { line: line('Yes.', 1000, '7') }), true);
  assert.equal(streams.keepsLine(M, 'B', { line: line('Yes.', 1000, '8') }), true);
  assert.equal(streams.keepsLine(M, 'B', { line: line('Yes.', 1000, '7') }), false);
  assert.equal(streams.keepsLine(M, 'A', { line: line('Yes.', 1000, '8') }), false);
});

test('copies whose timestamps differ by a few milliseconds are one line', () => {
  const { streams } = started(['A', 'B']);
  assert.equal(streams.keepsLine(M, 'A', { line: line('Good morning.', 60_000) }), true);
  assert.equal(streams.keepsLine(M, 'B', { line: line('Good morning.', 60_003) }), false);
  assert.equal(streams.keepsLine(M, 'B', { line: line('And you?', 61_000) }), true);
  assert.equal(streams.keepsLine(M, 'A', { line: line('And you?', 60_997) }), false);
});

test('the same words more than 5 seconds apart on the streams\' clocks are two lines', () => {
  const { streams } = started(['A', 'B']);
  assert.equal(streams.keepsLine(M, 'A', { line: line('Okay.', 60_000) }), true);
  assert.equal(streams.keepsLine(M, 'B', { line: line('Okay.', 65_000) }), false); // 5 seconds: still the same
  assert.equal(streams.keepsLine(M, 'A', { line: line('Right.', 60_000) }), true);
  assert.equal(streams.keepsLine(M, 'B', { line: line('Right.', 65_001) }), true);
});

test('with no timestamps at all, copies that arrive close together are one line', () => {
  const { streams, after } = started(['A', 'B']);
  const bare = (text) => ({ speakerId: '7', text });
  assert.equal(streams.keepsLine(M, 'A', { line: bare('one') }), true);
  after(2);
  assert.equal(streams.keepsLine(M, 'B', { line: bare('one') }), false);
  assert.equal(streams.keepsLine(M, 'B', { line: bare('two') }), true);
  after(10);
  assert.equal(streams.keepsLine(M, 'A', { line: bare('two') }), false); // 10 seconds: still the same
  // one copy with a timestamp and one without are compared by arrival too
  assert.equal(streams.keepsLine(M, 'A', { line: line('three', 70_000) }), true);
  assert.equal(streams.keepsLine(M, 'B', { line: { speakerId: '7', tStartMs: '70000', text: 'three' } }), false);
});

test('a copy that arrives 30 seconds late: recognised by its timestamp, stored again without one (never lost)', () => {
  const { streams, after } = started(['A', 'B']);
  assert.equal(streams.keepsLine(M, 'A', { line: line('with a timestamp', 60_000) }), true);
  assert.equal(streams.keepsLine(M, 'A', { line: { speakerId: '7', text: 'without one' } }), true);
  after(30);
  assert.equal(streams.keepsLine(M, 'B', { line: line('with a timestamp', 60_000) }), false);
  // nothing ties this copy to the first but the words: it is stored again, a duplicate
  assert.equal(streams.keepsLine(M, 'B', { line: { speakerId: '7', text: 'without one' } }), true);
});

test('a copy that arrives after the 2 minutes the memory covers is stored again', () => {
  const { streams, after } = started(['A', 'B']);
  assert.equal(streams.keepsLine(M, 'A', { line: line('one', 60_000) }), true);
  after(119);
  assert.equal(streams.keepsLine(M, 'B', { line: line('one', 60_000) }), false);
  assert.equal(streams.keepsLine(M, 'A', { line: line('two', 61_000) }), true);
  after(121);
  assert.equal(streams.keepsLine(M, 'B', { line: line('two', 61_000) }), true);
});

test('the memory of stored lines is bounded: 300 lines by default, and the limits can be set', () => {
  const { streams } = started(['A', 'B']);
  for (let n = 0; n <= 300; n += 1) assert.equal(streams.keepsLine(M, 'A', { line: lineNo(n) }), true);
  assert.equal(streams.remembered(M).lines, 300);
  assert.equal(streams.keepsLine(M, 'B', { line: lineNo(300) }), false);
  assert.equal(streams.keepsLine(M, 'B', { line: lineNo(1) }), false);
  assert.equal(streams.keepsLine(M, 'B', { line: lineNo(0) }), true); // the oldest fell out

  const small = started(['A', 'B'], {
    maxRecentLines: 2, recentLineMs: 20_000, sameLineStampMs: 100, sameLineArrivalMs: 1000,
  });
  replay(small.streams, [['A', 1], ['A', 2], ['A', 3]]);
  assert.deepEqual(replay(small.streams, [['B', 3], ['B', 2], ['B', 1]]), [1]);
  assert.equal(small.streams.keepsLine(M, 'A', { line: line('x', 1000) }), true);
  assert.equal(small.streams.keepsLine(M, 'B', { line: line('x', 1101) }), true);
  assert.equal(small.streams.keepsLine(M, 'A', { line: { speakerId: '7', text: 'y' } }), true);
  small.after(2);
  assert.equal(small.streams.keepsLine(M, 'B', { line: { speakerId: '7', text: 'y' } }), true);
  small.after(20);
  assert.equal(small.streams.keepsLine(M, 'B', { line: line('x', 1000) }), true);
});

test('a line that cannot be identified is stored, never taken for a duplicate', () => {
  const { streams } = started(['A', 'B']);
  for (const odd of [undefined, null, 'text', { speakerId: '7' }, { text: 42 }]) {
    assert.equal(streams.keepsLine(M, 'A', { line: odd }), true);
    assert.equal(streams.keepsLine(M, 'B', { line: odd }), true);
  }
  assert.equal(streams.keepsLine(M, 'A'), true);
  // a missing speaker id is one speaker, and a number is the speaker it names
  assert.equal(streams.keepsLine(M, 'A', { line: { text: 'no speaker', tStartMs: 1 } }), true);
  assert.equal(streams.keepsLine(M, 'B', { line: { text: 'no speaker', tStartMs: 1, speakerId: null } }), false);
  assert.equal(streams.keepsLine(M, 'A', { line: { text: 'a number', tStartMs: 1, speakerId: 7 } }), true);
  assert.equal(streams.keepsLine(M, 'B', { line: { text: 'a number', tStartMs: 1, speakerId: '7' } }), false);
  assert.equal(streams.keepsLine(M, 'B', { line: { text: 'a number', tStartMs: 1, speakerId: 8 } }), true);
});

// --- a line is a copy only for a stream that existed when it was stored ------

test('a stream that replaces its user\'s old one: the same words said again are a second line', () => {
  const { streams, after } = setup();
  streams.streamStarted(M, { streamId: 'A', operatorId: 'op-1' });
  assert.equal(streams.keepsLine(M, 'A', { line: line('Okay.', 100_000) }), true);
  after(2);
  streams.streamStarted(M, { streamId: 'B', operatorId: 'op-1' }); // replaces A
  after(1.5);
  // B did not exist when the first one was stored: this cannot be its copy
  assert.equal(streams.keepsLine(M, 'B', { line: line('Okay.', 103_500) }), true);
});

test('a stream stops and another starts: the same words said again are a second line', () => {
  const { streams, after } = setup();
  streams.streamStarted(M, { streamId: 'A', operatorId: 'op-1' });
  assert.equal(streams.keepsLine(M, 'A', { line: line('Okay.', 100_000) }), true);
  after(1);
  streams.streamStopped(M, 'A');
  after(1);
  streams.streamStarted(M, { streamId: 'B', operatorId: 'op-2' });
  after(1.5);
  assert.equal(streams.keepsLine(M, 'B', { line: line('Okay.', 103_500) }), true);

  // the same stream id stopping and starting again is a new start too
  const again = started(['A', 'B']);
  assert.equal(again.streams.keepsLine(M, 'A', { line: line('Okay.', 100_000) }), true);
  again.streams.streamStopped(M, 'B');
  again.after(2);
  again.streams.streamStarted(M, { streamId: 'B', operatorId: 'op-B' });
  again.after(1.5);
  assert.equal(again.streams.keepsLine(M, 'B', { line: line('Okay.', 103_500) }), true);
});

test('the same without timestamps: a new stream\'s line is not a copy of one stored before it started', () => {
  const { streams, after } = setup();
  const bare = (text) => ({ speakerId: '7', text });
  streams.streamStarted(M, { streamId: 'A', operatorId: 'op-1' });
  assert.equal(streams.keepsLine(M, 'A', { line: bare('Okay.') }), true);
  after(3);
  streams.streamStarted(M, { streamId: 'B', operatorId: 'op-1' });
  after(5); // 8 seconds after the first: inside the 10 seconds copies are told by
  assert.equal(streams.keepsLine(M, 'B', { line: bare('Okay.') }), true);
  // and a stream first heard of through its data, seconds after the line was stored
  after(2);
  assert.equal(streams.keepsLine(M, 'C', { line: bare('Okay.') }), true);
});

test('a stream that starts mid-meeting: its copies of lines stored after it started are dropped', () => {
  const { streams, after } = started(['A']);
  const stored = replay(streams, [['A', 1], ['A', 2]]);
  after(20);
  streams.streamStarted(M, { streamId: 'B', operatorId: 'op-B' });
  after(3);
  replay(streams, [['A', 3], ['B', 3], ['B', 4], ['A', 4], ['A', 5]], stored);
  after(8);
  replay(streams, [['B', 5]], stored);
  assert.deepEqual(stored, [1, 2, 3, 4, 5]);
});

test('a line stored up to a second before a stream was first seen can still be its copy', () => {
  // Zoom may deliver to a stream that just started a line whose copy from
  // another stream arrived a moment earlier
  const { streams, after } = started(['A']);
  assert.equal(streams.keepsLine(M, 'A', { line: line('one', 60_000) }), true);
  after(1);
  streams.streamStarted(M, { streamId: 'B', operatorId: 'op-B' });
  assert.equal(streams.keepsLine(M, 'B', { line: line('one', 60_000) }), false);

  assert.equal(streams.keepsLine(M, 'A', { line: line('two', 61_000) }), true);
  after(1.001);
  streams.streamStarted(M, { streamId: 'C', operatorId: 'op-C' });
  assert.equal(streams.keepsLine(M, 'C', { line: line('two', 61_000) }), true);

  // the grace can be set
  const wide = started(['A'], { startGraceMs: 4000 });
  assert.equal(wide.streams.keepsLine(M, 'A', { line: line('one', 60_000) }), true);
  wide.after(4);
  assert.equal(wide.streams.keepsLine(M, 'B', { line: line('one', 60_000) }), false);
  assert.equal(wide.streams.keepsLine(M, 'A', { line: line('two', 61_000) }), true);
  wide.after(4.001);
  assert.equal(wide.streams.keepsLine(M, 'C', { line: line('two', 61_000) }), true);
});

test('a participant event is a copy only for a stream that existed when it was kept', () => {
  const { streams, after } = started(['A']);
  assert.equal(streams.keepsEvent(M, 'A', { event: { eventType: 'left', participantId: '12' } }), true);
  after(3);
  streams.streamStarted(M, { streamId: 'B', operatorId: 'op-A' }); // replaces A
  after(2);
  // the same person leaving again, reported by the new stream only
  assert.equal(streams.keepsEvent(M, 'B', { event: { eventType: 'left', participantId: '12' } }), true);

  // both streams were there: one event
  streams.streamStarted(M, { streamId: 'C', operatorId: 'op-C' });
  after(2);
  assert.equal(streams.keepsEvent(M, 'B', { event: { eventType: 'joined', participantId: '13' } }), true);
  assert.equal(streams.keepsEvent(M, 'C', { event: { eventType: 'joined', participantId: '13' } }), false);
  // within the second of grace
  assert.equal(streams.keepsEvent(M, 'C', { event: { eventType: 'joined', participantId: '14' } }), true);
  after(1);
  assert.equal(streams.keepsEvent(M, 'D', { event: { eventType: 'joined', participantId: '14' } }), false);
});

// --- participant events arrive once per stream too ---------------------------

const joined = (participantId, extra = {}) => ({ eventType: 'joined', participantId, participantName: `P${participantId}`, ...extra });

test('a participant event is kept once, whichever streams reported it', () => {
  const { streams, after } = started(['A', 'B', 'C']);
  assert.equal(streams.keepsEvent(M, 'A', { event: joined('12') }), true);
  after(1);
  assert.equal(streams.keepsEvent(M, 'B', { event: joined('12', { timestamp: 5 }) }), false);
  assert.equal(streams.keepsEvent(M, 'C', { event: joined('12') }), false);
  // another person, and the same person leaving, are other events
  assert.equal(streams.keepsEvent(M, 'B', { event: joined('13') }), true);
  assert.equal(streams.keepsEvent(M, 'B', { event: { eventType: 'left', participantId: '12' } }), true);
  assert.equal(streams.keepsEvent(M, 'A', { event: { eventType: 'left', participantId: '12' } }), false);
});

test('the same event again on one stream, or more than 10 seconds later on another, is a new event', () => {
  const { streams, after } = started(['A', 'B']);
  assert.equal(streams.keepsEvent(M, 'A', { event: joined('12') }), true);
  assert.equal(streams.keepsEvent(M, 'A', { event: joined('12') }), true); // left and came back
  assert.equal(streams.keepsEvent(M, 'B', { event: joined('12') }), false);
  assert.equal(streams.keepsEvent(M, 'B', { event: joined('12') }), false);
  after(11);
  assert.equal(streams.keepsEvent(M, 'B', { event: joined('12') }), true);
});

test('a second stream\'s roster of the people already there is the first stream\'s roster again', () => {
  const { streams } = started(['A', 'B']);
  const roster = ['1', '2', '3'].map((id) => ({ eventType: 'initial_roster', participantId: id, participantName: `P${id}` }));
  assert.deepEqual(roster.map((event) => streams.keepsEvent(M, 'A', { event })), [true, true, true]);
  assert.deepEqual(roster.map((event) => streams.keepsEvent(M, 'B', { event })), [false, false, false]);
});

test('without a participant id the name tells people apart', () => {
  const { streams } = started(['A', 'B']);
  const named = (participantName) => ({ eventType: 'joined', participantId: null, participantName });
  assert.equal(streams.keepsEvent(M, 'A', { event: named('Ana') }), true);
  assert.equal(streams.keepsEvent(M, 'B', { event: named('Ben') }), true);
  assert.equal(streams.keepsEvent(M, 'B', { event: named('Ana') }), false);
  // with an id, the name does not matter
  assert.equal(streams.keepsEvent(M, 'A', { event: joined('12', { participantName: 'Cy' }) }), true);
  assert.equal(streams.keepsEvent(M, 'B', { event: joined('12', { participantName: 'Cy R.' }) }), false);
});

test('an event that cannot be identified is kept, never taken for a duplicate', () => {
  const { streams } = started(['A', 'B']);
  for (const odd of [undefined, null, 'joined', {}, { eventType: 'joined' }, { participantId: '1' }, { eventType: 7, participantId: '1' }]) {
    assert.equal(streams.keepsEvent(M, 'A', { event: odd }), true);
    assert.equal(streams.keepsEvent(M, 'B', { event: odd }), true);
  }
});

test('the memory of events is bounded', () => {
  const { streams, after } = started(['A', 'B'], { maxRecentEvents: 3 });
  for (const id of ['1', '2', '3', '4']) streams.keepsEvent(M, 'A', { event: joined(id) });
  assert.equal(streams.remembered(M).events, 3);
  assert.equal(streams.keepsEvent(M, 'B', { event: joined('4') }), false);
  assert.equal(streams.keepsEvent(M, 'B', { event: joined('1') }), true); // the oldest fell out
  after(11);
  streams.keepsEvent(M, 'A', { event: joined('9') });
  assert.equal(streams.remembered(M).events, 1); // what is too old to match goes
});

// --- forget ------------------------------------------------------------------

test('forget removes everything known about a meeting, and only that meeting', () => {
  const { streams } = started(['A', 'B']);
  streams.streamStarted('MEETING-2==', { streamId: 's9', operatorId: 'op-9' });
  streams.keepsLine(M, 'A', { line: lineNo(1) });
  streams.keepsEvent(M, 'A', { event: joined('12') });
  streams.keepsLine('MEETING-2==', 's9', { line: lineNo(1) });
  streams.forget(M);

  assert.deepEqual(streams.operators(M), []);
  assert.equal(streams.isPrimary(M, 'A'), false);
  assert.equal(streams.anyLive(M), false);
  assert.equal(streams.remembered(M), null);
  assert.equal(streams.isPrimary('MEETING-2==', 's9'), true);
  assert.equal(streams.size(), 1);
  // the memory of stored lines and events went too
  assert.equal(streams.keepsLine(M, 'B', { line: lineNo(1) }), true);
  assert.equal(streams.keepsEvent(M, 'B', { event: joined('12') }), true);
  assert.equal(streams.keepsLine('MEETING-2==', 's8', { line: lineNo(1) }), false);
});

// --- pause is per stream ------------------------------------------------------

test('one stream: pausing it pauses the meeting, resuming it resumes', () => {
  const { streams } = started(['A']);
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 0, operators: [] });
  assert.equal(streams.setPaused(M, { streamId: 'A' }, true), true);
  assert.deepEqual(streams.pauseState(M), { meeting: true, streams: 1, operators: ['op-A'] });
  assert.equal(streams.setPaused(M, { streamId: 'A' }, false), true);
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 0, operators: [] });
});

test('the meeting is paused only when every live stream is', () => {
  const { streams } = started(['A', 'B']);
  streams.setPaused(M, { operatorId: 'op-A' }, true); // by whose stream it is
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 1, operators: ['op-A'] });
  streams.setPaused(M, { streamId: 'B' }, true);
  assert.deepEqual(streams.pauseState(M), { meeting: true, streams: 2, operators: ['op-A', 'op-B'] });
  streams.setPaused(M, { operatorId: 'op-A' }, false);
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 1, operators: ['op-B'] });
});

test('a stream that stops is no longer paused, and the meeting follows the streams that run', () => {
  const { streams } = started(['A', 'B']);
  streams.setPaused(M, { streamId: 'A' }, true);
  streams.streamStopped(M, 'A');
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 0, operators: [] });
  // the running stream stopping leaves only a paused one: the meeting is paused
  streams.streamStarted(M, { streamId: 'A2', operatorId: 'op-A' });
  streams.setPaused(M, { streamId: 'A2' }, true);
  streams.streamStopped(M, 'B');
  assert.equal(streams.pauseState(M).meeting, true);
  // with nothing live, nothing is paused
  streams.streamStopped(M, 'A2');
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 0, operators: [] });
  streams.streamStarted(M, { streamId: 'A2', operatorId: 'op-A' }); // started again: running
  assert.equal(streams.pauseState(M).meeting, false);

  streams.setPaused(M, { streamId: 'A2' }, true);
  streams.stopAll(M);
  assert.equal(streams.pauseState(M).streams, 0);
});

test('a stream that reports itself running again after a rejoin stays paused', () => {
  const { streams } = started(['A']);
  streams.setPaused(M, { streamId: 'A' }, true);
  streams.streamStarted(M, { streamId: 'A', operatorId: 'op-A' });
  assert.equal(streams.pauseState(M).meeting, true);
});

test('a line from a paused stream shows it is running, once the lines that were on their way are through', () => {
  const { streams, after } = started(['A', 'B']);
  streams.setPaused(M, { streamId: 'A' }, true);
  streams.setPaused(M, { streamId: 'B' }, true);
  after(2);
  assert.equal(streams.keepsLine(M, 'A', { line: lineNo(1) }), true); // said before the pause
  assert.equal(streams.pauseState(M).meeting, true);
  after(1);
  assert.equal(streams.keepsLine(M, 'A', { line: lineNo(2) }), true);
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 1, operators: ['op-B'] });
  // a copy shows it as well as a first delivery; a participant event does not
  streams.keepsEvent(M, 'B', { event: { eventType: 'joined', participantId: '1' } });
  assert.equal(streams.pauseState(M).streams, 1);
  streams.keepsLine(M, 'B', { line: lineNo(2) });
  assert.equal(streams.pauseState(M).streams, 0);

  const quick = started(['A'], { pauseSettleMs: 500 });
  quick.streams.setPaused(M, { streamId: 'A' }, true);
  quick.after(1);
  quick.streams.keepsLine(M, 'A', { line: lineNo(1) });
  assert.equal(quick.streams.pauseState(M).meeting, false);
});

// --- a pause Zoom confirmed (the rtms service's report) -------------------------

test('lines within 15 seconds of a confirmed pause do not clear it; a line after that does', () => {
  const { streams, after } = started(['A']);
  streams.setPaused(M, { streamId: 'A' }, true, { confirmed: true });
  // lines said before the pause, still on their way: well past the 3s of a browser's pause
  after(4);
  streams.keepsLine(M, 'A', { line: lineNo(1) });
  after(10.999);
  streams.keepsLine(M, 'A', { line: lineNo(2) });
  assert.equal(streams.pauseState(M).meeting, true);
  // Zoom delivers nothing on a paused stream: 15 seconds on, a line means the resume was lost
  after(0.001);
  assert.equal(streams.keepsLine(M, 'A', { line: lineNo(3) }), true);
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 0, operators: [] });
  // and it is an ordinary running stream again: a new pause report marks it
  streams.setPaused(M, { streamId: 'A' }, true, { confirmed: true });
  assert.equal(streams.pauseState(M).meeting, true);
});

test('only lines from the paused stream itself clear its confirmed pause, and a participant event never does', () => {
  const { streams, after } = started(['A', 'B']);
  streams.setPaused(M, { streamId: 'A' }, true, { confirmed: true });
  after(60);
  streams.keepsLine(M, 'B', { line: lineNo(1) });
  streams.keepsEvent(M, 'A', { event: { eventType: 'joined', participantId: '1' } });
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 1, operators: ['op-A'] });
  // a copy of a line shows it as well as a first delivery
  assert.equal(streams.keepsLine(M, 'A', { line: lineNo(1) }), false);
  assert.equal(streams.pauseState(M).streams, 0);
});

test('how long a confirmed pause stands against lines is an option of its own', () => {
  const { streams, after } = started(['A'], { confirmedPauseStaleMs: 30_000, pauseSettleMs: 500 });
  streams.setPaused(M, { streamId: 'A' }, true, { confirmed: true });
  after(29);
  streams.keepsLine(M, 'A', { line: lineNo(1) });
  assert.equal(streams.pauseState(M).meeting, true);
  after(1);
  streams.keepsLine(M, 'A', { line: lineNo(2) });
  assert.equal(streams.pauseState(M).meeting, false);
});

test('a confirmed pause and a real resume are as before', () => {
  const { streams, after } = started(['A']);
  streams.setPaused(M, { streamId: 'A' }, true, { confirmed: true });
  after(5);
  streams.setPaused(M, { streamId: 'A' }, false, { confirmed: true });
  assert.equal(streams.pauseState(M).meeting, false);
  after(60);
  streams.keepsLine(M, 'A', { line: lineNo(1) });
  assert.equal(streams.pauseState(M).meeting, false);
});

test('a panel\'s report of a pause Zoom confirmed leaves it confirmed, and counted from when Zoom said so', () => {
  const { streams, after } = started(['A']);
  streams.setPaused(M, { streamId: 'A' }, true, { confirmed: true });
  after(10);
  // the owner's panel reports the same pause: not a browser's pause now
  assert.equal(streams.setPaused(M, { operatorId: 'op-A' }, true), true);
  after(4);
  streams.keepsLine(M, 'A', { line: lineNo(1) });
  assert.equal(streams.pauseState(M).meeting, true, 'a line 4s after the panel\'s report does not clear a confirmed pause');
  // 15s after Zoom's word, not after the panel's
  after(1);
  streams.keepsLine(M, 'A', { line: lineNo(2) });
  assert.equal(streams.pauseState(M).meeting, false);
});

test('the service confirming a pause a panel reported makes it confirmed, from then', () => {
  const { streams, after } = started(['A']);
  streams.setPaused(M, { operatorId: 'op-A' }, true);
  after(2);
  streams.setPaused(M, { streamId: 'A' }, true, { confirmed: true });
  after(5);
  streams.keepsLine(M, 'A', { line: lineNo(1) });
  assert.equal(streams.pauseState(M).meeting, true);
});

test('the owner\'s own resume report ends a pause Zoom confirmed', () => {
  const { streams, after } = started(['A', 'B']);
  streams.setPaused(M, { streamId: 'A' }, true, { confirmed: true });
  // another owner's report is about their own stream, not this one
  streams.setPaused(M, { operatorId: 'op-B' }, false);
  assert.deepEqual(streams.pauseState(M).operators, ['op-A']);
  streams.setPaused(M, { operatorId: 'op-A' }, false);
  assert.equal(streams.pauseState(M).streams, 0);
  // and a pause reported after that is a browser's again: a line 3s on clears it
  streams.setPaused(M, { operatorId: 'op-A' }, true);
  after(3);
  streams.keepsLine(M, 'A', { line: lineNo(1) });
  assert.equal(streams.pauseState(M).streams, 0);
});

test('whether the stored timeline says "paused" is forgotten when nothing runs', () => {
  const { streams } = started(['A', 'B']);
  assert.equal(streams.pauseKept(M), false);
  assert.equal(streams.pauseKept(M, true), true);
  // one stream stopping while another runs changes nothing about it
  streams.streamStopped(M, 'A');
  assert.equal(streams.pauseKept(M), true);
  streams.streamStopped(M, 'B');
  assert.equal(streams.pauseKept(M), false);

  streams.streamStarted(M, { streamId: 'C', operatorId: 'op-C' });
  streams.pauseKept(M, true);
  streams.stopAll(M);
  assert.equal(streams.pauseKept(M), false);
  assert.equal(streams.pauseKept('UNKNOWN=='), false);
});

test('only a running stream can be paused, and only the one named', () => {
  const { streams } = started(['A', 'B']);
  streams.streamStopped(M, 'B');
  assert.equal(streams.setPaused(M, { streamId: 'B' }, true), false);
  assert.equal(streams.setPaused(M, { streamId: 'nobody' }, true), false);
  assert.equal(streams.setPaused(M, { operatorId: 'op-B' }, true), false);
  assert.equal(streams.setPaused(M, { operatorId: 'op-nobody' }, true), false);
  assert.equal(streams.setPaused(M, { streamId: 42 }, true), false);
  assert.equal(streams.setPaused(M, { operatorId: 42 }, true), false);
  assert.equal(streams.setPaused('UNKNOWN==', { streamId: 'A' }, true), false);
  assert.equal(streams.setPaused(M, undefined, true), false);
  assert.deepEqual(streams.pauseState(M), { meeting: false, streams: 0, operators: [] });
  assert.deepEqual(streams.pauseState('UNKNOWN=='), { meeting: false, streams: 0, operators: [] });
  assert.equal(streams.size(), 1);
});

test('a pause report without a stream id is about the meeting\'s one stream', () => {
  const { streams } = setup();
  streams.streamStarted(M, { operatorId: 'op-1' });
  assert.equal(streams.setPaused(M, {}, true), true);
  assert.equal(streams.pauseState(M).meeting, true);
  assert.equal(streams.setPaused(M, { streamId: 's1' }, false), true); // Zoom names the stream
  assert.equal(streams.pauseState(M).meeting, false);

  // with several streams known by id it cannot be told whose it is: nothing is marked
  const two = started(['A', 'B']);
  assert.equal(two.streams.setPaused(M, {}, true), false);
  assert.equal(two.streams.pauseState(M).streams, 0);
});

test('liveOperators lists whose streams are running', () => {
  const { streams } = started(['A', 'B']);
  streams.streamStarted(M, { streamId: 'C' }); // no operator known
  assert.deepEqual(streams.liveOperators(M), ['op-A', 'op-B']);
  streams.streamStopped(M, 'A');
  assert.deepEqual(streams.liveOperators(M), ['op-B']);
  assert.deepEqual(streams.liveOperators('UNKNOWN=='), []);
});

// --- a stream its user replaced: the wait for the new one ---------------------

function withTimers(options) {
  const timers = [];
  const schedule = (fn, ms) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  return { ...started(['A'], { schedule, ...options }), timers };
}

test('the wait for a replacing stream ends by itself after 90 seconds', () => {
  const { streams, timers } = withTimers();
  let calls = 0;
  streams.streamStopped(M, 'A');
  assert.equal(streams.awaitingReplacement(M), false);
  streams.awaitReplacement(M, () => { calls += 1; });
  assert.equal(streams.awaitingReplacement(M), true);
  assert.deepEqual(timers.map((t) => t.ms), [90_000]);
  // asked again while waiting: the first wait goes on, no second timer
  streams.awaitReplacement(M, () => { calls += 10; });
  assert.equal(timers.length, 1);

  timers[0].fn();
  assert.equal(calls, 1);
  assert.equal(streams.awaitingReplacement(M), false);
  timers[0].fn(); // a timer that fires twice says nothing twice
  assert.equal(calls, 1);
});

test('the wait is settled when the new stream\'s outcome is known, and the timer is cancelled', () => {
  const { streams, timers } = withTimers({ replacementWaitMs: 5000 });
  let calls = 0;
  streams.awaitReplacement(M, () => { calls += 1; });
  assert.equal(timers[0].ms, 5000);
  assert.equal(streams.settleReplacement(M), true);
  assert.equal(timers[0].cancelled, true);
  assert.equal(streams.awaitingReplacement(M), false);
  assert.equal(streams.settleReplacement(M), false); // nothing to settle
  assert.equal(streams.settleReplacement('UNKNOWN=='), false);
  timers[0].fn(); // a cancelled timer that fires anyway does nothing
  assert.equal(calls, 0);
});

test('the wait does not outlive the meeting: forget, the meeting ending and the meeting limit end it', () => {
  for (const end of [
    (streams) => streams.forget(M),
    (streams) => streams.stopAll(M),
    (streams) => { streams.streamStarted('M2', { streamId: 'x' }); streams.streamStarted('M3', { streamId: 'y' }); },
  ]) {
    const { streams, timers } = withTimers({ maxMeetings: 2 });
    let calls = 0;
    streams.awaitReplacement(M, () => { calls += 1; });
    end(streams);
    assert.equal(timers[0].cancelled, true);
    assert.equal(streams.awaitingReplacement(M), false);
    timers[0].fn();
    assert.equal(calls, 0);
  }
  // nothing is awaited for a meeting that is not known, or with a callback that is not one
  const { streams, timers } = withTimers();
  streams.awaitReplacement('UNKNOWN==', () => {});
  streams.awaitReplacement(M, 'not a function');
  assert.equal(timers.length, 0);
  assert.equal(streams.size(), 1);
});

test('hasStopped is true only for a stream that is known and no longer running', () => {
  const { streams } = started(['A', 'B']);
  assert.equal(streams.hasStopped(M, 'A'), false);
  streams.streamStopped(M, 'A');
  assert.equal(streams.hasStopped(M, 'A'), true);
  assert.equal(streams.hasStopped(M, 'never-seen'), false);
  assert.equal(streams.hasStopped(M, undefined), false);
  assert.equal(streams.hasStopped(M, 42), false);
  assert.equal(streams.hasStopped('UNKNOWN==', 'A'), false);
});
