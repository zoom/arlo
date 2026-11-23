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
