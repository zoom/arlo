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
