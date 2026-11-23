// Several Zoom users can each run a stream in one meeting. This is the record
// of those streams and the choice of the one whose lines are stored.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingStreams } = require('../src/services/meetingStreams');

function setup(options) {
  const warnings = [];
  const streams = createMeetingStreams({ log: { warn: (line) => warnings.push(line) }, ...options });
  return { streams, warnings };
}
const M = 'MEETING-1==';

test('the first stream is the source', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });

  assert.equal(streams.isSource(M, 's1'), true);
  assert.equal(streams.isSource(M, 's2'), false);
  assert.equal(streams.sourceOperator(M), 'op-1');
  assert.equal(streams.anyLive(M), true);
});

test('nothing is known about a meeting no stream was reported for', () => {
  const { streams } = setup();
  assert.equal(streams.isSource(M, 's1'), false);
  assert.equal(streams.anyLive(M), false);
  assert.deepEqual(streams.operators(M), []);
  assert.equal(streams.sourceOperator(M), null);
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: false });
  assert.equal(streams.size(), 0);
});

test('an original-host stream that starts later becomes the source', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-host', originalHost: true });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3' });

  assert.equal(streams.isSource(M, 's2'), true);
  assert.equal(streams.isSource(M, 's1'), false);
  assert.equal(streams.sourceOperator(M), 'op-host');
});

test('only the boolean true marks the original host', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2', originalHost: 'true' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3', originalHost: 1 });
  assert.equal(streams.isSource(M, 's1'), true);
});

test('the source stopping hands over to the next live stream, in the order they started', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3' });

  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: true });
  assert.equal(streams.isSource(M, 's2'), true);
  assert.equal(streams.isSource(M, 's1'), false);
  assert.deepEqual(streams.streamStopped(M, 's2'), { anyLive: true });
  assert.equal(streams.isSource(M, 's3'), true);
});

test('a stream that is not the source stopping changes nothing', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  assert.deepEqual(streams.streamStopped(M, 's2'), { anyLive: true });
  assert.equal(streams.isSource(M, 's1'), true);
});

test('when the original host\'s stream stops, the stream that started first takes over', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-host', originalHost: true });
  streams.streamStopped(M, 's3');
  assert.equal(streams.isSource(M, 's1'), true);
});

test('the source does not change while it runs, whoever else starts', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-host', originalHost: true });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2', originalHost: true }); // cannot be, but must not flip
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-host', originalHost: true }); // reported again after a rejoin
  assert.equal(streams.isSource(M, 's1'), true);
});

test('after the last stream stopped nothing is live, and its late lines still belong to it', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStopped(M, 's2');
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: false });
  assert.equal(streams.anyLive(M), false);
  assert.equal(streams.acceptsDataFrom(M, 's1'), true);
  assert.equal(streams.acceptsDataFrom(M, 's2'), false);
  assert.equal(streams.anyLive(M), false); // a late line does not bring a stopped stream back

  // the next stream to start is the source, not the stopped one
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3' });
  assert.equal(streams.isSource(M, 's3'), true);
  assert.equal(streams.acceptsDataFrom(M, 's1'), false);
});

test('operators lists everyone whose stream was seen, the source\'s first, each once', () => {
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
  assert.equal(streams.sourceOperator(M), 'op-2');
});

test('the same user starting again replaces their old stream, as the rtms service does', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-1' });

  assert.equal(streams.isSource(M, 's2'), true); // s1 is gone, s2 started before s3
  assert.deepEqual(streams.operators(M), ['op-2', 'op-1']);
  streams.streamStopped(M, 's2');
  assert.deepEqual(streams.streamStopped(M, 's3'), { anyLive: false }); // s1 does not count as live
});

test('a report without a stream id is the only stream of its meeting', () => {
  const { streams } = setup();
  streams.streamStarted(M, { operatorId: 'op-1' });
  assert.equal(streams.isSource(M, undefined), true);
  assert.equal(streams.acceptsDataFrom(M, undefined), true);
  assert.equal(streams.sourceOperator(M), 'op-1');
  assert.deepEqual(streams.streamStopped(M, undefined), { anyLive: false });
});

test('a stop without a stream id stops every stream of the meeting', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  assert.deepEqual(streams.streamStopped(M), { anyLive: false });
  assert.deepEqual(streams.operators(M), ['op-1', 'op-2']);
});

test('a stream first heard of through its lines counts as started (this server restarted mid-meeting)', () => {
  const { streams } = setup();
  assert.equal(streams.acceptsDataFrom(M, 's1'), true);
  assert.equal(streams.anyLive(M), true);
  assert.equal(streams.acceptsDataFrom(M, 's2'), false); // a second one is not the source
  assert.equal(streams.isSource(M, 's1'), true);

  // its start report arrives late and fills in whose stream it is
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  assert.equal(streams.sourceOperator(M), 'op-1');
  // the original host's does too, and takes over
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-host', originalHost: true });
  assert.equal(streams.acceptsDataFrom(M, 's2'), true);
});

test('at most 20 streams are kept per meeting; more are ignored with one warning', () => {
  const { streams, warnings } = setup();
  for (let i = 1; i <= 25; i += 1) streams.streamStarted(M, { streamId: `s${i}`, operatorId: `op-${i}` });

  assert.equal(streams.operators(M).length, 20);
  assert.equal(streams.isSource(M, 's21'), false);
  assert.equal(streams.acceptsDataFrom(M, 's26'), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('op-'), false);

  // stopping the first 20 leaves nothing live: the ignored ones were never counted
  for (let i = 1; i <= 19; i += 1) streams.streamStopped(M, `s${i}`);
  assert.deepEqual(streams.streamStopped(M, 's20'), { anyLive: false });
});

test('ids that are not sane strings are refused', () => {
  const { streams } = setup();
  for (const bad of [42, '', null, {}, 'x'.repeat(257)]) {
    streams.streamStarted(bad, { streamId: 's1', operatorId: 'op-1' });
    streams.streamStarted(M, { streamId: bad === null ? 7 : bad, operatorId: 'op-1' });
  }
  assert.equal(streams.size(), 0);

  streams.streamStarted(M, { streamId: 's1', operatorId: 42 });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'x'.repeat(257) });
  assert.deepEqual(streams.operators(M), []);
  assert.equal(streams.isSource(M, 's1'), true);
  assert.equal(streams.acceptsDataFrom(M, 42), false);
  assert.deepEqual(streams.streamStopped(M, 42), { anyLive: true }); // a bad id stops nothing
});

test('forget removes everything known about a meeting, and only that meeting', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted('MEETING-2==', { streamId: 's9', operatorId: 'op-9' });
  streams.forget(M);

  assert.deepEqual(streams.operators(M), []);
  assert.equal(streams.isSource(M, 's1'), false);
  assert.equal(streams.anyLive(M), false);
  assert.equal(streams.isSource('MEETING-2==', 's9'), true);
  assert.equal(streams.size(), 1);
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
  assert.equal(streams.isSource(M, 's1'), true);
  assert.equal(streams.acceptsDataFrom(M, 's1'), true);
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  assert.deepEqual(streams.operators(M), ['op-1']);
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: false });
});

test('a report without a stream id in a meeting whose streams are known by id is taken as the stored one', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, {});
  assert.equal(streams.isSource(M, undefined), true);
  assert.equal(streams.acceptsDataFrom(M, undefined), true);
  assert.equal(streams.isSource(M, 's1'), true); // and nothing was added or replaced
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: false });
});

// --- the meeting ended: every stream is over -------------------------------

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

// --- a source that went silent without a stop report ------------------------

function timed(options) {
  const clock = { now: 1_000_000 };
  const { streams, warnings } = setup({ now: () => clock.now, ...options });
  const after = (seconds) => { clock.now += seconds * 1000; };
  return { streams, warnings, clock, after };
}

test('a line from another live stream takes over when the source has delivered nothing for 30 seconds', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  assert.equal(streams.acceptsDataFrom(M, 's1'), true);

  after(29);
  assert.equal(streams.acceptsDataFrom(M, 's2'), false); // not yet
  after(1);
  assert.equal(streams.acceptsDataFrom(M, 's2'), true); // its line is kept
  assert.equal(streams.isSource(M, 's2'), true);
  assert.equal(streams.isSource(M, 's1'), false);
  assert.equal(streams.sourceOperator(M), 'op-2');
  assert.deepEqual(streams.operators(M), ['op-2', 'op-1']);
  assert.equal(streams.anyLive(M), true);
});

test('the source is not switched while it keeps delivering', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1' });
  streams.streamStarted(M, { streamId: 's2' });
  for (let i = 0; i < 10; i += 1) {
    after(20);
    assert.equal(streams.acceptsDataFrom(M, 's1'), true);
    assert.equal(streams.acceptsDataFrom(M, 's2'), false);
  }
  assert.equal(streams.isSource(M, 's1'), true);
});

test('silence in the meeting switches nothing: only a line from another stream can', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1' });
  streams.streamStarted(M, { streamId: 's2' });
  streams.acceptsDataFrom(M, 's1');
  after(600); // nobody spoke for ten minutes
  assert.equal(streams.isSource(M, 's1'), true);
  streams.streamStarted(M, { streamId: 's3' }); // nor does a stream starting
  assert.equal(streams.isSource(M, 's1'), true);
  assert.equal(streams.acceptsDataFrom(M, 's1'), true);
  assert.equal(streams.acceptsDataFrom(M, 's2'), false);
});

test('a source that never delivered counts as silent from when it became the source', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1' });
  after(10);
  streams.streamStarted(M, { streamId: 's2' });
  after(19);
  assert.equal(streams.acceptsDataFrom(M, 's2'), false);
  after(1);
  assert.equal(streams.acceptsDataFrom(M, 's2'), true);
});

test('a stream that took over is given 30 seconds of its own before it can be replaced', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1' });
  streams.streamStarted(M, { streamId: 's2' });
  streams.streamStarted(M, { streamId: 's3' });
  after(30);
  assert.equal(streams.acceptsDataFrom(M, 's2'), true);
  after(29);
  assert.equal(streams.acceptsDataFrom(M, 's3'), false);
  after(1);
  assert.equal(streams.acceptsDataFrom(M, 's3'), true);
});

test('a silent original-host stream loses the source role, and gets it back only by the same rule', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 'host', operatorId: 'op-host', originalHost: true });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.acceptsDataFrom(M, 'host');
  after(31);
  assert.equal(streams.acceptsDataFrom(M, 's2'), true);

  // it does not come back because it is the original host: not when another
  // stream starts, not when it reports itself running, not when it delivers
  // while the current source is delivering too
  after(60);
  streams.acceptsDataFrom(M, 's2');
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3' });
  streams.streamStarted(M, { streamId: 'host', operatorId: 'op-host', originalHost: true });
  assert.equal(streams.isSource(M, 's2'), true);
  assert.equal(streams.acceptsDataFrom(M, 'host'), false);
  after(20);
  assert.equal(streams.acceptsDataFrom(M, 's2'), true);
  assert.equal(streams.acceptsDataFrom(M, 'host'), false);

  // the current source goes silent: the host's line takes over, like anyone's
  after(30);
  assert.equal(streams.acceptsDataFrom(M, 'host'), true);
  assert.equal(streams.isSource(M, 'host'), true);
  // and from then on it is the preferred stream again
  streams.streamStopped(M, 's3');
  streams.streamStarted(M, { streamId: 's3', operatorId: 'op-3' });
  assert.equal(streams.isSource(M, 'host'), true);
});

test('an original-host stream that stopped and started again is preferred again', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 'host', originalHost: true });
  streams.streamStarted(M, { streamId: 's2' });
  after(30);
  assert.equal(streams.acceptsDataFrom(M, 's2'), true);
  streams.streamStopped(M, 'host');
  streams.streamStarted(M, { streamId: 'host', originalHost: true });
  assert.equal(streams.isSource(M, 'host'), true);
});

test('when the source stops, a stream that lost the role through silence is chosen last', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1' });
  streams.streamStarted(M, { streamId: 's2' });
  streams.streamStarted(M, { streamId: 's3' });
  after(30);
  streams.acceptsDataFrom(M, 's2'); // s1 went silent
  after(10);
  streams.streamStopped(M, 's2');
  assert.equal(streams.isSource(M, 's3'), true);
  streams.streamStopped(M, 's3');
  assert.equal(streams.isSource(M, 's1'), true); // the only one left
});

test('after a pause in the talk, the stream whose copy arrives first does not keep the role from a source that is alive', () => {
  // Every stream carries the same speech. After 30 quiet seconds the first
  // line of the next sentence can arrive from another stream a moment before
  // the source's copy. That is not a dead source.
  const { streams, clock, after } = timed();
  streams.streamStarted(M, { streamId: 'host', operatorId: 'op-host', originalHost: true });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.acceptsDataFrom(M, 'host');
  after(45);
  assert.equal(streams.acceptsDataFrom(M, 's2'), true); // kept: one copy of the line
  clock.now += 80;
  assert.equal(streams.acceptsDataFrom(M, 'host'), false); // the same line again: dropped
  assert.equal(streams.isSource(M, 'host'), true); // and the source is who it was
  assert.equal(streams.sourceOperator(M), 'op-host');
  after(1);
  assert.equal(streams.acceptsDataFrom(M, 'host'), true);
  assert.equal(streams.acceptsDataFrom(M, 's2'), false);
});

test('a displaced source that delivers only later does not get the role back for that', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1' });
  streams.streamStarted(M, { streamId: 's2' });
  after(30);
  assert.equal(streams.acceptsDataFrom(M, 's2'), true);
  after(6); // past the 5 seconds in which a copy of the same line would arrive
  assert.equal(streams.acceptsDataFrom(M, 's1'), false);
  assert.equal(streams.isSource(M, 's2'), true);
});

test('a stopped stream never takes over, however silent the source is', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1' });
  streams.streamStarted(M, { streamId: 's2' });
  streams.streamStopped(M, 's2');
  after(120);
  assert.equal(streams.acceptsDataFrom(M, 's2'), false);
  assert.equal(streams.isSource(M, 's1'), true);
  // nor a stream past the limit, nor a bad id
  assert.equal(streams.acceptsDataFrom(M, 42), false);
});

test('the silence limit can be set', () => {
  const { streams, after } = timed({ sourceSilentMs: 5000 });
  streams.streamStarted(M, { streamId: 's1' });
  streams.streamStarted(M, { streamId: 's2' });
  after(4);
  assert.equal(streams.acceptsDataFrom(M, 's2'), false);
  after(1);
  assert.equal(streams.acceptsDataFrom(M, 's2'), true);
});

// --- around a change of source: decide by content, never lose a line ---------

// Every stream carries the same speech: line n is the same speaker, time and
// words on each of them
const lineNo = (n) => ({ speakerId: '7', tStartMs: 50_000 + n * 1000, text: `line ${n}` });
/** Feed lines as [streamId, n] pairs; returns the numbers of the lines kept, in order. */
function replay(streams, sequence, stored = []) {
  for (const [streamId, n] of sequence) {
    if (streams.acceptsDataFrom(M, streamId, { line: lineNo(n) })) stored.push(n);
  }
  return stored;
}
/** Streams A (the source) and B, A silent for 35 seconds after line 0. */
function silentSource() {
  const t = timed();
  t.streams.streamStarted(M, { streamId: 'A', operatorId: 'op-a' });
  t.streams.streamStarted(M, { streamId: 'B', operatorId: 'op-b' });
  t.stored = replay(t.streams, [['A', 0]]);
  t.after(35);
  return t;
}

test('after a silence switch, the old source\'s next line arriving first is kept, and the other copy dropped', () => {
  const { streams, stored, after } = silentSource();
  replay(streams, [['B', 1]], stored);
  assert.equal(streams.isSource(M, 'B'), true);
  after(3);
  replay(streams, [['A', 2], ['B', 2]], stored);
  assert.deepEqual(stored, [0, 1, 2]);
  assert.equal(streams.isSource(M, 'A'), true); // it delivered within the revert time
});

test('after a silence switch, two lines from the new source followed by the old source\'s copies are stored once each', () => {
  const { streams, stored } = silentSource();
  replay(streams, [['B', 1], ['B', 2], ['A', 1], ['A', 2]], stored);
  assert.deepEqual(stored, [0, 1, 2]);
});

test('after a silence switch, copies interleaved in any order are stored once each', () => {
  for (const order of [
    [['B', 1], ['A', 1], ['B', 2], ['A', 2], ['A', 3], ['B', 3]],
    [['B', 1], ['A', 1], ['A', 2], ['B', 2], ['B', 3], ['A', 3]],
    [['B', 1], ['B', 2], ['A', 1], ['B', 3], ['A', 2], ['A', 3]],
    [['B', 1], ['A', 2], ['A', 1], ['B', 3], ['B', 2], ['A', 3]],
  ]) {
    const { streams, stored } = silentSource();
    replay(streams, order, stored);
    assert.deepEqual([...stored].sort(), [0, 1, 2, 3], JSON.stringify(order));
    assert.equal(stored.length, 4, JSON.stringify(order));
  }
});

test('when the source stops, its copy of a line still in flight is kept, though the other stream\'s copy was dropped', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 'A' });
  streams.streamStarted(M, { streamId: 'B' });
  const stored = replay(streams, [['A', 1], ['B', 1], ['B', 2]]); // B's copies: A is the source
  assert.deepEqual(stored, [1]);
  streams.streamStopped(M, 'A');
  assert.equal(streams.isSource(M, 'B'), true);
  after(1);
  replay(streams, [['A', 2], ['B', 3], ['A', 3]], stored);
  assert.deepEqual(stored, [1, 2, 3]);
  assert.equal(streams.anyLive(M), true);
  assert.equal(streams.isSource(M, 'B'), true); // a stopped stream's late lines do not bring it back

  // only for a moment: later lines from the stopped stream are not kept
  after(10);
  assert.deepEqual(replay(streams, [['A', 4]]), []);
  assert.deepEqual(replay(streams, [['B', 4]]), [4]);
});

test('when the source stops after its copy was stored, the next source\'s copy of that line is dropped', () => {
  const { streams } = timed();
  streams.streamStarted(M, { streamId: 'A' });
  streams.streamStarted(M, { streamId: 'B' });
  const stored = replay(streams, [['A', 1]]);
  streams.streamStopped(M, 'A');
  replay(streams, [['B', 1], ['B', 2], ['A', 2]], stored);
  assert.deepEqual(stored, [1, 2]);
});

test('when the original host\'s stream takes over, the old source\'s lines in flight are kept once', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1' });
  const stored = replay(streams, [['s1', 1]]);
  streams.streamStarted(M, { streamId: 'host', originalHost: true });
  replay(streams, [['s1', 2], ['host', 2], ['host', 3], ['s1', 3]], stored);
  assert.deepEqual(stored, [1, 2, 3]);
  after(10);
  replay(streams, [['s1', 4], ['host', 4]], stored);
  assert.deepEqual(stored, [1, 2, 3, 4]);
  assert.equal(streams.isSource(M, 'host'), true);
});

test('the time around a change of source in which both streams are heard can be set', () => {
  const { streams, after } = timed({ changeWindowMs: 2000 });
  streams.streamStarted(M, { streamId: 'A' });
  streams.streamStarted(M, { streamId: 'B' });
  streams.streamStopped(M, 'A');
  after(1);
  assert.deepEqual(replay(streams, [['A', 1]]), [1]);
  after(1);
  assert.deepEqual(replay(streams, [['A', 2]]), []);
});

test('two streams delivering the same lines in steady state store one copy of each', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 'A' });
  streams.streamStarted(M, { streamId: 'B' });
  const stored = [];
  for (let n = 1; n <= 6; n += 1) {
    after(4);
    replay(streams, n % 2 ? [['A', n], ['B', n]] : [['B', n], ['A', n]], stored);
  }
  assert.deepEqual(stored, [1, 2, 3, 4, 5, 6]);
  assert.equal(streams.isSource(M, 'A'), true);
});

test('the same line twice from the source itself is stored once', () => {
  const { streams } = timed();
  streams.streamStarted(M, { streamId: 'A' });
  assert.deepEqual(replay(streams, [['A', 1], ['A', 1], ['A', 2]]), [1, 2]);
});

test('the same speaker saying the same words again later is stored', () => {
  const { streams } = timed();
  streams.streamStarted(M, { streamId: 'A' });
  const said = (tStartMs, speakerId = '7') => streams.acceptsDataFrom(M, 'A', { line: { speakerId, tStartMs, text: 'Yes.' } });
  assert.equal(said(1000), true);
  assert.equal(said(1000), false);
  assert.equal(said(4000), true);
  assert.equal(said(4000, '8'), true); // someone else, at the same moment
});

test('a line without a usable timestamp is never taken for a duplicate', () => {
  const { streams } = timed();
  streams.streamStarted(M, { streamId: 'A' });
  for (const tStartMs of [undefined, null, '1000', NaN]) {
    assert.equal(streams.acceptsDataFrom(M, 'A', { line: { speakerId: '7', tStartMs, text: 'Yes.' } }), true);
    assert.equal(streams.acceptsDataFrom(M, 'A', { line: { speakerId: '7', tStartMs, text: 'Yes.' } }), true);
  }
  assert.equal(streams.acceptsDataFrom(M, 'A', { line: null }), true);
});

test('the memory of stored lines is bounded by count and by age', () => {
  const { streams, after } = timed({ maxRecentLines: 3 });
  streams.streamStarted(M, { streamId: 'A' });
  assert.deepEqual(replay(streams, [['A', 1], ['A', 2], ['A', 3], ['A', 4]]), [1, 2, 3, 4]);
  assert.deepEqual(replay(streams, [['A', 4], ['A', 3]]), []); // still remembered
  assert.deepEqual(replay(streams, [['A', 1]]), [1]); // the oldest was let go
  after(121);
  assert.deepEqual(replay(streams, [['A', 4]]), [4]); // two minutes on, nothing is remembered

  const many = timed();
  many.streams.streamStarted(M, { streamId: 'A' });
  const all = Array.from({ length: 201 }, (unused, i) => ['A', i + 1]);
  assert.equal(replay(many.streams, all).length, 201);
  assert.deepEqual(replay(many.streams, [['A', 2]]), []);
  assert.deepEqual(replay(many.streams, [['A', 1]]), [1]); // 200 are remembered, not 201
});

test('forget removes the memory of stored lines with the rest', () => {
  const { streams } = timed();
  streams.streamStarted(M, { streamId: 'A' });
  streams.streamStarted('OTHER==', { streamId: 'A' });
  assert.equal(streams.acceptsDataFrom(M, 'A', { line: lineNo(1) }), true);
  assert.equal(streams.acceptsDataFrom('OTHER==', 'A', { line: lineNo(1) }), true); // per meeting
  streams.forget(M);
  assert.equal(streams.acceptsDataFrom(M, 'A', { line: lineNo(1) }), true);
  assert.equal(streams.acceptsDataFrom('OTHER==', 'A', { line: lineNo(1) }), false);
});

test('timeline events from a stream that is not the source are dropped, also around a change of source', () => {
  const { streams } = timed();
  streams.streamStarted(M, { streamId: 'A' });
  streams.streamStarted(M, { streamId: 'B' });
  streams.streamStopped(M, 'A');
  assert.equal(streams.acceptsDataFrom(M, 'A'), false); // no line: an event
  assert.equal(streams.acceptsDataFrom(M, 'B'), true);
  assert.equal(streams.acceptsDataFrom(M, 'A', { line: lineNo(1) }), true); // its lines are
});

// --- whose stream it is, learned from its data (this server restarted) -------

test('a stream first heard of through its lines gets its operator and original-host flag from them', () => {
  const { streams } = setup();
  assert.equal(streams.acceptsDataFrom(M, 's1', { line: lineNo(1), operatorId: 'op-1' }), true);
  assert.deepEqual(streams.operators(M), ['op-1']);
  assert.equal(streams.sourceOperator(M), 'op-1');

  // a second one is known too, though its lines are not the stored ones
  assert.equal(streams.acceptsDataFrom(M, 's2', { line: lineNo(2), operatorId: 'op-2' }), false);
  assert.deepEqual(streams.operators(M), ['op-1', 'op-2']);
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: true });

  // the original host's stream takes over, as it does when its start is reported
  assert.equal(streams.acceptsDataFrom(M, 's3', { operatorId: 'op-host', originalHost: true }), true);
  assert.equal(streams.isSource(M, 's3'), true);
  assert.deepEqual(streams.operators(M), ['op-host', 'op-1', 'op-2']);
});

test('data fills in an operator that was not known, and never changes one that was', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-2' });
  streams.acceptsDataFrom(M, 's1', { line: lineNo(1), operatorId: 'op-1' });
  streams.acceptsDataFrom(M, 's2', { line: lineNo(1), operatorId: 'op-other' });
  assert.deepEqual(streams.operators(M), ['op-1', 'op-2']);

  // values that are not sane are not used; only the boolean marks the original host
  streams.acceptsDataFrom(M, 's4', { line: lineNo(2), operatorId: 42, originalHost: 'true' });
  streams.acceptsDataFrom(M, 's5', { line: lineNo(2), operatorId: 'x'.repeat(257), originalHost: 1 });
  assert.deepEqual(streams.operators(M), ['op-1', 'op-2']);
  assert.equal(streams.isSource(M, 's1'), true);
});

test('a known stream learned to be the original host\'s from its data becomes the source', () => {
  const { streams } = setup();
  streams.acceptsDataFrom(M, 's1', { line: lineNo(1), operatorId: 'op-1' });
  streams.acceptsDataFrom(M, 's2', { line: lineNo(1), operatorId: 'op-2' });
  assert.equal(streams.isSource(M, 's1'), true);
  assert.equal(streams.acceptsDataFrom(M, 's2', { line: lineNo(2), operatorId: 'op-2', originalHost: true }), true);
  assert.equal(streams.isSource(M, 's2'), true);
});

test('data from a stream never replaces another stream of the same user', () => {
  const { streams } = setup();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.acceptsDataFrom(M, 's0', { line: lineNo(1), operatorId: 'op-1' }); // a line of an older stream of theirs
  assert.equal(streams.isSource(M, 's1'), true);
  assert.equal(streams.acceptsDataFrom(M, 's1', { line: lineNo(2) }), true);
});

test('a stream its user replaced counts as stopped: late lines do not bring it back', () => {
  const { streams, after } = timed();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'op-1' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'op-1' });
  assert.equal(streams.isSource(M, 's2'), true);
  // its lines still on their way are kept for a moment, like any stopped source's
  assert.equal(streams.acceptsDataFrom(M, 's1', { line: lineNo(1), operatorId: 'op-1' }), true);
  after(11);
  assert.equal(streams.acceptsDataFrom(M, 's1', { line: lineNo(2), operatorId: 'op-1' }), false);
  assert.deepEqual(streams.streamStopped(M, 's1'), { anyLive: true }); // the rtms service's report for it
  assert.deepEqual(streams.streamStopped(M, 's2'), { anyLive: false });
  assert.deepEqual(streams.operators(M), ['op-1']);
});

test('a user who keeps starting new streams does not fill the meeting with old ones', () => {
  const { streams, warnings } = setup();
  streams.streamStarted(M, { streamId: 'other', operatorId: 'op-2' });
  for (let i = 1; i <= 60; i += 1) streams.streamStarted(M, { streamId: `s${i}`, operatorId: 'op-1' });
  assert.deepEqual(warnings, []);
  streams.streamStarted(M, { streamId: 'third', operatorId: 'op-3' });
  assert.deepEqual(streams.operators(M), ['op-2', 'op-1', 'op-3']);
  streams.streamStopped(M, 'other');
  streams.streamStopped(M, 'third');
  assert.deepEqual(streams.streamStopped(M, 's60'), { anyLive: false });
});
