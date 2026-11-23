// Integration: several users each run a stream in one meeting. The server
// keeps one transcript (from one stream), and the meeting only counts as
// stopped when the last stream has stopped.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', MEETING_FLUSH_GRACE_MS: '200' });

const test = require('node:test');
const assert = require('node:assert/strict');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const internal = { 'x-arlo-internal-key': h.internalKey() };
// Each stream numbers its own lines from 1, as the rtms service does
const say = (meetingId, streamId, seqNo, text) => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, streamId, segment: { seqNo, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: 1000, tEndMs: 1000 } },
  internal,
);
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
const events = (meetingId, streamId, list) => h.postJson(
  `${srv.base}/api/rtms/participant-event`, { meetingId, streamId, events: list }, internal,
);

async function cookieFor(meetingId) {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
  );
  return cookie;
}
async function history(meetingId, path, cookie) {
  const res = await fetch(`${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/${path}`, { headers: { cookie } });
  return (await res.json());
}
async function openPanel(meetingId, cookie) {
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, { cookie });
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId } }));
  await h.wait(100);
  return ws;
}
const ofType = (ws, type) => ws.messages.filter((m) => m.type === type).map((m) => m.data);
const texts = async (meetingId, cookie) => (await history(meetingId, 'transcript', cookie)).segments.map((s) => s.text);

test('lines from a second stream are neither stored nor sent to the panels', async () => {
  const meeting = 'MULTI-A==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });

  const first = await say(meeting, 's1', 1, 'Heard on the first stream.');
  const second = await say(meeting, 's2', 1, 'The same words on the second stream.');
  await h.wait(150);
  ws.socket.close();

  assert.equal(first.status, 200);
  assert.equal('stored' in first.body, false);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { received: true, stored: false, broadcast: 0 });
  assert.deepEqual(await texts(meeting, cookie), ['Heard on the first stream.']);
  assert.deepEqual(ofType(ws, 'transcript.segment').map((d) => d.segment.text), ['Heard on the first stream.']);
});

test('after the first stream stops, the second stream\'s lines are stored and the numbers continue', async () => {
  const meeting = 'MULTI-B==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'one');
  await say(meeting, 's2', 1, 'dropped');
  await say(meeting, 's1', 2, 'two');
  await say(meeting, 's2', 2, 'dropped');

  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  // the second stream has counted its own lines: 3 was never sent, 1 and 2 were dropped
  await say(meeting, 's2', 7, 'three');
  await say(meeting, 's2', 1, 'four');

  const { segments } = await history(meeting, 'transcript', cookie);
  assert.deepEqual(segments.map((s) => [s.seqNo, s.text]), [[1, 'one'], [2, 'two'], [3, 'three'], [4, 'four']]);
});

test('the original host\'s stream becomes the one that is stored when it starts', async () => {
  const meeting = 'MULTI-C==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await say(meeting, 's1', 1, 'before the host stream');
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-host', originalHost: true });
  await say(meeting, 's1', 2, 'dropped');
  await say(meeting, 's2', 1, 'from the host stream');
  assert.deepEqual(await texts(meeting, cookie), ['before the host stream', 'from the host stream']);

  // only the boolean counts
  const other = 'MULTI-C2==';
  await status(other, { status: 'rtms_started', streamId: 's1' });
  await status(other, { status: 'rtms_started', streamId: 's2', originalHost: 'true' });
  assert.equal((await say(other, 's2', 1, 'dropped')).body.stored, false);
});

test('the panels are told the meeting stopped only after the last stream stops', async () => {
  const meeting = 'MULTI-D==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's2', fault: true });
  await h.wait(100);
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started']);

  // a panel that opens now still finds a running stream
  const later = await openPanel(meeting, cookie);
  later.socket.close();
  assert.deepEqual(ofType(later, 'meeting.status').map((d) => d.status), ['rtms_started']);

  await status(meeting, { status: 'rtms_stopped', streamId: 's1', fault: true });
  await h.wait(100);
  ws.socket.close();
  const told = ofType(ws, 'meeting.status');
  assert.deepEqual(told.map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.equal(told[1].fault, true); // the last stream's fault is the meeting's

  // one "started" and one "stopped" line in the timeline, not one per stream
  const stored = (await history(meeting, 'participant-events', cookie)).events.map((e) => e.eventType);
  assert.deepEqual(stored, ['transcription_started', 'transcription_stopped']);
});

test('when the stored stream stops while it was reconnecting, the panels learn that a stream is running', async () => {
  const meeting = 'MULTI-E==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await status(meeting, { status: 'rtms_interrupted', streamId: 's1' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', fault: true });
  await h.wait(100);
  ws.socket.close();
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_interrupted', 'rtms_started']);
  assert.equal((await say(meeting, 's2', 1, 'kept')).body.stored, undefined);
});

test('trouble on a stream that is not the stored one is not shown to the meeting', async () => {
  const meeting = 'MULTI-F==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await status(meeting, { status: 'rtms_interrupted', streamId: 's2' });
  await status(meeting, { status: 'media_interrupted', streamId: 's2' });
  await status(meeting, { status: 'rtms_reconnected', streamId: 's2' });
  await status(meeting, { status: 'rtms_failed', streamId: 's2' });
  await status(meeting, { status: 'rtms_failed', streamId: 's3' }); // a third stream that never got in
  await h.wait(100);
  ws.socket.close();

  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started']);
  // and the first stream is still the one stored
  await say(meeting, 's1', 1, 'kept');
  assert.deepEqual(await texts(meeting, cookie), ['kept']);
});

test('a stream that fails while another runs does not start the idle flush', async () => {
  const meeting = 'MULTI-G==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await say(meeting, 's1', 1, 'kept');
  await status(meeting, { status: 'rtms_failed', streamId: 's2' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's3' });
  await h.wait(450); // longer than the grace period, and no panel is connected
  assert.deepEqual(await texts(meeting, cookie), ['kept']);
});

test('participant events from a stream that is not the stored one are dropped', async () => {
  const meeting = 'MULTI-H==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  const joined = [{ eventType: 'joined', participantName: 'Ben', participantId: '12', timestamp: 1700000000000 }];
  const dropped = await events(meeting, 's2', joined);
  await events(meeting, 's1', joined);

  assert.deepEqual(dropped.body, { received: true, stored: false, broadcast: 0 });
  const stored = (await history(meeting, 'participant-events', cookie)).events.map((e) => e.eventType);
  assert.deepEqual(stored, ['transcription_started', 'joined']);
});

test('the meeting ending with the last stream flushes; one of two streams ending does not', async () => {
  const { getMeetingStreams } = require('../src/services/meetingStreams');
  const meeting = 'MULTI-I==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'Said during the meeting.');

  await status(meeting, { status: 'rtms_stopped', streamId: 's2', meetingEnded: true });
  assert.deepEqual(await texts(meeting, cookie), ['Said during the meeting.']);
  assert.deepEqual(getMeetingStreams().operators(meeting), ['op-1', 'op-2']);

  await status(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  assert.deepEqual(await texts(meeting, cookie), []);
  // what was known about the meeting's streams went with the flush
  assert.deepEqual(getMeetingStreams().operators(meeting), []);
  assert.equal((await say(meeting, 's1', 2, 'Arrived after the end.')).body.stored, false);
  assert.equal(getMeetingStreams().anyLive(meeting), false);
});

test('an idle flush forgets the meeting\'s streams too', async () => {
  const { getMeetingStreams } = require('../src/services/meetingStreams');
  const meeting = 'MULTI-J==';
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await say(meeting, 's1', 1, 'x');
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  assert.deepEqual(getMeetingStreams().operators(meeting), ['op-1']); // kept through a stop
  await h.wait(450);
  assert.deepEqual(getMeetingStreams().operators(meeting), []);
});

test('reports without a stream id work as before: one stream per meeting', async () => {
  const meeting = 'MULTI-K==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', operatorId: 'op-1' });
  await say(meeting, undefined, 1, 'one');
  await status(meeting, { status: 'rtms_stopped' });
  await status(meeting, { status: 'rtms_started', operatorId: 'op-1' });
  await say(meeting, undefined, 1, 'two');
  await h.wait(100);
  ws.socket.close();

  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_stopped', 'rtms_started']);
  const { segments } = await history(meeting, 'transcript', cookie);
  assert.deepEqual(segments.map((s) => [s.seqNo, s.text]), [[1, 'one'], [2, 'two']]);
});

test('a stream id or operator id that is not a sane string is refused', async () => {
  const meeting = 'MULTI-L==';
  for (const bad of [42, '', 'x'.repeat(257), { id: 's1' }, ['s1']]) {
    assert.equal((await status(meeting, { status: 'rtms_started', streamId: bad })).status, 400);
    assert.equal((await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: bad })).status, 400);
    assert.equal((await say(meeting, bad, 1, 'x')).status, 400);
    assert.equal((await events(meeting, bad, [{ eventType: 'joined' }])).status, 400);
  }
  const cookie = await cookieFor(meeting);
  assert.deepEqual(await texts(meeting, cookie), []);
});

test('Zoom\'s own stop webhook for one of two streams, with the rtms service unreachable, is not a meeting stop', async () => {
  const meeting = 'MULTI-M==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await say(meeting, 's1', 1, 'kept');

  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's2', stop_reason: 6 } });
  await h.wait(100);
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started']);
  assert.deepEqual(await texts(meeting, cookie), ['kept']);

  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's1', stop_reason: 6 } });
  await h.wait(100);
  ws.socket.close();
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.deepEqual(await texts(meeting, cookie), []);
});
