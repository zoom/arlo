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
/** Run `fn` with the server's clock moved ahead (the tests share the process with it). */
async function later(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
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
  // a line of the old source still on its way is kept, once
  await say(meeting, 's1', 2, 'in flight at the change');
  assert.equal((await say(meeting, 's2', 1, 'in flight at the change')).body.stored, false);
  await say(meeting, 's2', 2, 'from the host stream');
  await later(11_000, () => say(meeting, 's1', 3, 'dropped'));
  assert.deepEqual(await texts(meeting, cookie), ['before the host stream', 'in flight at the change', 'from the host stream']);

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

test('the meeting ending, reported on any one stream, ends every stream and flushes', async () => {
  const { getMeetingStreams } = require('../src/services/meetingStreams');
  const meeting = 'MULTI-I==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'Said during the meeting.');

  // only the boolean counts: this is one stream stopping, and the other runs on
  await status(meeting, { status: 'rtms_stopped', streamId: 's2', meetingEnded: 'true' });
  assert.deepEqual(await texts(meeting, cookie), ['Said during the meeting.']);
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });

  // the report comes on the stream that is not the stored one, while the other is live
  const ended = await status(meeting, { status: 'rtms_stopped', streamId: 's2', meetingEnded: true });
  assert.equal(ended.status, 200);
  assert.deepEqual(await texts(meeting, cookie), []);
  assert.deepEqual((await history(meeting, 'participant-events', cookie)).events, []);
  assert.equal(getMeetingStreams().anyLive(meeting), false);
  // what was known about the meeting's streams went with the flush
  assert.deepEqual(getMeetingStreams().operators(meeting), []);
  assert.equal((await say(meeting, 's1', 2, 'Arrived after the end.')).body.stored, false);

  // the other stream's own stop reports, with and without the reason, change nothing
  const later = await status(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', fault: true });
  await status(meeting, { status: 'rtms_failed', streamId: 's1' });
  assert.deepEqual(later.body, { received: true, broadcast: 0 });
  await h.wait(150);
  ws.socket.close();

  const told = ofType(ws, 'meeting.status');
  assert.deepEqual(told.map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.equal(told[1].meetingEnded, true);
  assert.equal('fault' in told[1], false);
  const lines = ofType(ws, 'participant.event').map((d) => d.event.eventType);
  assert.deepEqual(lines, ['transcription_started', 'transcription_stopped']);
  // each panel's last word about Arlo: not here
  assert.equal(ofType(ws, 'arlo.state').at(-1).present, false);
  assert.deepEqual(await texts(meeting, cookie), []);
  assert.equal((await say(meeting, 's1', 3, 'Still refused.')).body.stored, false);
});

test('after a meeting ended, the same meeting id can run again', async () => {
  const meeting = 'MULTI-I2==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  await status(meeting, { status: 'rtms_started', streamId: 's3' });
  await say(meeting, 's3', 1, 'again');
  assert.deepEqual(await texts(meeting, cookie), ['again']);
  // and a stop is a stop again
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_stopped', streamId: 's3' });
  await h.wait(100);
  ws.socket.close();
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_stopped']);
});

test('a source stream that goes silent without a stop report is replaced by the stream that still delivers', async () => {
  const meeting = 'MULTI-N==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'one');
  await status(meeting, { status: 'rtms_interrupted', streamId: 's1' }); // the panels show "Reconnecting…"
  assert.equal((await say(meeting, 's2', 1, 'dropped')).body.stored, false);

  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    const kept = await say(meeting, 's2', 2, 'two');
    assert.equal('stored' in kept.body, false);
    await say(meeting, 's2', 3, 'three');
  } finally {
    Date.now = realNow;
  }
  await h.wait(100);
  ws.socket.close();

  const { segments } = await history(meeting, 'transcript', cookie);
  assert.deepEqual(segments.map((s) => [s.seqNo, s.text]), [[1, 'one'], [2, 'two'], [3, 'three']]);
  // the panels learn that a stream is running again
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_interrupted', 'rtms_started']);
  // trouble on the old stream is no longer the meeting's
  const quiet = await status(meeting, { status: 'rtms_interrupted', streamId: 's1' });
  assert.deepEqual(quiet.body, { received: true, broadcast: 0 });
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

  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's2', stop_reason: 1 } });
  await h.wait(100);
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started']);
  assert.deepEqual(await texts(meeting, cookie), ['kept']);

  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's1', stop_reason: 1 } });
  await h.wait(100);
  ws.socket.close();
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.deepEqual(await texts(meeting, cookie), ['kept']);
});

test('Zoom\'s own stop webhook saying the meeting ended, for one of two streams, ends the meeting', async () => {
  const meeting = 'MULTI-O==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await say(meeting, 's1', 1, 'kept until the end');

  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's2', stop_reason: 6 } });
  assert.deepEqual(await texts(meeting, cookie), []);
  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's1', stop_reason: 6 } });
  await h.wait(100);
  ws.socket.close();
  const told = ofType(ws, 'meeting.status');
  assert.deepEqual(told.map((d) => [d.status, d.meetingEnded === true]), [['rtms_started', false], ['rtms_stopped', true]]);
  assert.deepEqual(await texts(meeting, cookie), []);
});

// --- no line is lost, and none stored twice, around a change of source -------

test('the stopped source\'s copy of a line still in flight is stored when the other stream\'s copy was dropped', async () => {
  const meeting = 'MULTI-P==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'one');
  assert.equal((await say(meeting, 's2', 1, 'one')).body.stored, false);
  assert.equal((await say(meeting, 's2', 2, 'two')).body.stored, false); // s1 is the source
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await say(meeting, 's1', 2, 'two'); // was on its way when the stop was reported
  await say(meeting, 's2', 3, 'three');
  assert.deepEqual((await say(meeting, 's1', 3, 'three')).body, { received: true, stored: false, broadcast: 0 });
  await h.wait(100);
  ws.socket.close();

  assert.deepEqual(await texts(meeting, cookie), ['one', 'two', 'three']);
  assert.deepEqual(ofType(ws, 'transcript.segment').map((d) => d.segment.text), ['one', 'two', 'three']);
  // told once more at the handover (a stream is running), and not again for the late lines
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_started']);
  await later(11_000, async () => {
    assert.equal((await say(meeting, 's1', 4, 'too late')).body.stored, false);
  });
});

test('after a silent source was replaced, its next line arriving first is stored and the other copy dropped', async () => {
  const meeting = 'MULTI-Q==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'one');
  await later(35_000, () => say(meeting, 's2', 1, 'two'));
  await later(38_000, async () => {
    await say(meeting, 's1', 2, 'three');
    assert.equal((await say(meeting, 's2', 2, 'three')).body.stored, false);
  });
  assert.deepEqual(await texts(meeting, cookie), ['one', 'two', 'three']);
});

test('after a silent source was replaced, its late copies of lines stored from the other stream are dropped', async () => {
  const meeting = 'MULTI-R==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await say(meeting, 's1', 1, 'one');
  await later(35_000, async () => {
    await say(meeting, 's2', 1, 'two');
    await say(meeting, 's2', 2, 'three');
    await say(meeting, 's1', 2, 'two');
    await say(meeting, 's1', 3, 'three');
  });
  assert.deepEqual(await texts(meeting, cookie), ['one', 'two', 'three']);
});

test('the same words from the same speaker at another time are stored again', async () => {
  const meeting = 'MULTI-S==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  const yes = (tStartMs) => h.postJson(
    `${srv.base}/api/rtms/broadcast`,
    { meetingId: meeting, streamId: 's1', segment: { seqNo: 1, text: 'Yes.', speakerId: '7', speakerLabel: 'Ana', tStartMs, tEndMs: tStartMs } },
    internal,
  );
  await yes(1000);
  assert.equal((await yes(1000)).body.stored, false);
  await yes(9000);
  assert.deepEqual(await texts(meeting, cookie), ['Yes.', 'Yes.']);
});
