// Integration: what the server knows about a meeting's streams when it did not
// see them start (it restarted mid-meeting), and when the rtms service replaced
// a user's old stream with a new one.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', MEETING_FLUSH_GRACE_MS: '200', AI_ENABLED: 'false' });

const test = require('node:test');
const assert = require('node:assert/strict');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { getMeetingStreams } = require('../src/services/meetingStreams');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const internal = { 'x-arlo-internal-key': h.internalKey() };
let lineNo = 0;
/** A line as the rtms service sends it: with the stream it came on and whose stream that is. */
function say(meetingId, stream, text) {
  lineNo += 1;
  return h.postJson(
    `${srv.base}/api/rtms/broadcast`,
    { meetingId, ...stream, segment: { seqNo: lineNo, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: lineNo * 1000, tEndMs: lineNo * 1000 } },
    internal,
  );
}
const events = (meetingId, stream, list) => h.postJson(
  `${srv.base}/api/rtms/participant-event`, { meetingId, ...stream, events: list }, internal,
);
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);

function person(zoomUserId, displayName) {
  const user = userStore.upsert(zoomUserId, { email: `${zoomUserId}@example.test`, displayName, avatarUrl: null });
  return { user, zoomUserId, session: `sessionToken=${generateToken({ userId: user.id, zoomUserId })}` };
}
async function cookieFor(meetingId) {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
  );
  return cookie;
}
async function openPanel(meetingId, session) {
  const cookie = await cookieFor(meetingId);
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, { cookie: [cookie, session].filter(Boolean).join('; ') });
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId } }));
  await h.wait(100);
  return ws;
}
const ofType = (ws, type) => ws.messages.filter((m) => m.type === type).map((m) => m.data);
async function texts(meetingId) {
  const res = await fetch(`${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/transcript`, { headers: { cookie: await cookieFor(meetingId) } });
  return (await res.json()).segments.map((s) => s.text);
}

// --- the server restarted mid-meeting: streams are learned from their lines --

test('a stream first learned from its lines has its owner, and the panels are told once that it runs', async () => {
  const meeting = 'RESTART-A==';
  const ana = person('zoom-restart-ana', 'Ana Ruiz');
  const owner = await openPanel(meeting, ana.session);
  const guest = await openPanel(meeting, null);
  assert.equal(ofType(owner, 'arlo.state').at(-1).present, false);

  const stream = { streamId: 's1', operatorId: ana.zoomUserId };
  for (const text of ['one', 'two', 'three']) await say(meeting, stream, text);
  await h.wait(100);
  for (const ws of [owner, guest]) ws.socket.close();

  assert.deepEqual(await texts(meeting), ['one', 'two', 'three']);
  // once, not per line
  assert.deepEqual(ofType(owner, 'meeting.status').map((d) => d.status), ['rtms_started']);
  assert.deepEqual(ofType(guest, 'meeting.status').map((d) => d.status), ['rtms_started']);
  const told = ofType(owner, 'arlo.state').at(-1);
  assert.equal(told.present, true);
  assert.equal(told.role, 'owner');
  assert.equal(told.ownerName, 'Ana Ruiz');
  assert.equal(ofType(guest, 'arlo.state').at(-1).role, 'participant');
  assert.deepEqual(getMeetingStreams().operators(meeting), [ana.zoomUserId]);
  assert.equal(getMeetingStreams().anyLive(meeting), true);

  // a panel that opens now finds Arlo here too
  const later = await openPanel(meeting, ana.session);
  later.socket.close();
  assert.equal(ofType(later, 'arlo.state').at(-1).present, true);
  assert.deepEqual(ofType(later, 'meeting.status').map((d) => d.status), ['rtms_started']);
});

test('a stream first learned from a participant event counts too', async () => {
  const meeting = 'RESTART-B==';
  const ben = person('zoom-restart-ben', 'Ben Okafor');
  const panel = await openPanel(meeting, ben.session);
  await events(meeting, { streamId: 's1', operatorId: ben.zoomUserId }, [
    { eventType: 'joined', participantName: 'Cy', participantId: '12', timestamp: 1700000000000 },
  ]);
  await h.wait(100);
  panel.socket.close();
  assert.deepEqual(ofType(panel, 'meeting.status').map((d) => d.status), ['rtms_started']);
  assert.equal(ofType(panel, 'arlo.state').at(-1).role, 'owner');
});

test('with two streams learned from their lines, one stopping is not a meeting stop', async () => {
  const meeting = 'RESTART-C==';
  const ana = person('zoom-restart-ana', 'Ana Ruiz');
  const ben = person('zoom-restart-ben', 'Ben Okafor');
  const panel = await openPanel(meeting, ben.session);
  const s1 = { streamId: 's1', operatorId: ana.zoomUserId };
  const s2 = { streamId: 's2', operatorId: ben.zoomUserId };
  await say(meeting, s1, 'one');
  assert.equal((await say(meeting, s2, 'one')).body.stored, false); // the other stream's copy
  await h.wait(50);
  // both are owners
  assert.equal(ofType(panel, 'arlo.state').at(-1).role, 'owner');
  assert.deepEqual(getMeetingStreams().operators(meeting), [ana.zoomUserId, ben.zoomUserId]);

  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await h.wait(50);
  assert.equal(ofType(panel, 'meeting.status').some((d) => d.status === 'rtms_stopped'), false);
  assert.equal(ofType(panel, 'arlo.state').at(-1).present, true);
  await say(meeting, s2, 'two');

  await status(meeting, { status: 'rtms_stopped', streamId: 's2' });
  await h.wait(50);
  panel.socket.close();
  assert.equal(ofType(panel, 'meeting.status').at(-1).status, 'rtms_stopped');
  assert.equal(ofType(panel, 'arlo.state').at(-1).present, false);
  assert.equal(ofType(panel, 'arlo.state').at(-1).role, 'owner'); // still theirs after a stop
  assert.deepEqual(await texts(meeting), ['one', 'two']);
});

test('the original host\'s stream, learned from its lines, is the primary one', async () => {
  const meeting = 'RESTART-D==';
  await say(meeting, { streamId: 's1', operatorId: 'op-1' }, 'before the host stream was heard');
  const host = { streamId: 's2', operatorId: 'op-host', originalHost: true };
  await say(meeting, host, 'from the host stream');
  assert.equal(getMeetingStreams().isPrimary(meeting, 's2'), true);
  assert.equal(getMeetingStreams().primaryOperator(meeting), 'op-host');
  // only the boolean counts
  const other = 'RESTART-D2==';
  await say(other, { streamId: 's1' }, 'x');
  await say(other, { streamId: 's2', originalHost: 'true' }, 'y');
  assert.equal(getMeetingStreams().isPrimary(other, 's1'), true);
});

test('a late line from a stream that stopped does not make the meeting run again', async () => {
  const meeting = 'RESTART-E==';
  const panel = await openPanel(meeting, null);
  await say(meeting, { streamId: 's1', operatorId: 'op-1' }, 'one');
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await say(meeting, { streamId: 's1', operatorId: 'op-1' }, 'late');
  await h.wait(100);
  panel.socket.close();
  assert.deepEqual(ofType(panel, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.equal(ofType(panel, 'arlo.state').at(-1).present, false);
});

test('whose stream a line comes from is validated like a status report, and only the rtms service may say it', async () => {
  const meeting = 'RESTART-F==';
  const segment = { seqNo: 1, text: 'x', speakerId: '7', speakerLabel: 'Ana', tStartMs: 1000, tEndMs: 1000 };
  const joined = [{ eventType: 'joined', participantName: 'Cy', participantId: '12', timestamp: 1700000000000 }];
  for (const bad of [42, '', 'x'.repeat(257), { id: 'op' }, ['op'], true]) {
    const line = await h.postJson(`${srv.base}/api/rtms/broadcast`, { meetingId: meeting, streamId: 's1', operatorId: bad, segment }, internal);
    const event = await h.postJson(`${srv.base}/api/rtms/participant-event`, { meetingId: meeting, streamId: 's1', operatorId: bad, events: joined }, internal);
    assert.equal(line.status, 400);
    assert.equal(event.status, 400);
  }
  assert.deepEqual(getMeetingStreams().operators(meeting), []);
  assert.equal(getMeetingStreams().anyLive(meeting), false);

  const ana = person('zoom-restart-ana', 'Ana Ruiz');
  const fromBrowser = await h.postJson(
    `${srv.base}/api/rtms/broadcast`,
    { meetingId: meeting, streamId: 's1', operatorId: ana.zoomUserId, segment },
    { cookie: ana.session },
  );
  assert.ok([401, 403].includes(fromBrowser.status));
  assert.deepEqual(getMeetingStreams().operators(meeting), []);
});

// --- the same user started a new stream: the rtms service reports the old one stopped

test('the stop of a replaced stream, arriving after the new stream started, is not shown to the panels', async () => {
  const meeting = 'REPLACED-A==';
  const panel = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-1' });
  const stop = await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await h.wait(100);
  panel.socket.close();
  assert.deepEqual(stop.body, { received: true, broadcast: 0 });
  assert.equal(ofType(panel, 'meeting.status').some((d) => d.status === 'rtms_stopped'), false);
  assert.equal(ofType(panel, 'arlo.state').at(-1).present, true);
  assert.equal(getMeetingStreams().anyLive(meeting), true);
  await say(meeting, { streamId: 's2', operatorId: 'op-1' }, 'kept');
  assert.deepEqual(await texts(meeting), ['kept']);
});

test('a replaced stream reported stopped, then the new stream failing to join: the meeting is stopped and its data goes', async () => {
  const meeting = 'REPLACED-B==';
  const panel = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await say(meeting, { streamId: 's1', operatorId: 'op-1' }, 'said before the restart');
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await status(meeting, { status: 'rtms_failed', streamId: 's2' });
  await h.wait(100);
  panel.socket.close();

  const told = ofType(panel, 'meeting.status').map((d) => d.status);
  assert.deepEqual(told.slice(0, 2), ['rtms_started', 'rtms_stopped']);
  assert.equal(told.includes('rtms_started', 1), false);
  assert.equal(ofType(panel, 'arlo.state').at(-1).present, false);
  assert.equal(getMeetingStreams().anyLive(meeting), false);
  // the lifecycle sees no stream running: with the last panel gone the data is flushed
  await h.wait(450);
  assert.deepEqual(await texts(meeting), []);
});

test('a late line from a stream its user replaced does not bring that stream back', async () => {
  const meeting = 'REPLACED-C==';
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-1' });
  await say(meeting, { streamId: 's1', operatorId: 'op-1' }, 'on its way when the stream was replaced');
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await say(meeting, { streamId: 's1', operatorId: 'op-1' }, 'later still');
  await status(meeting, { status: 'rtms_stopped', streamId: 's2' });
  // s2 was the last running stream: the old one never counted as running again
  assert.equal(getMeetingStreams().anyLive(meeting), false);
  assert.deepEqual((await texts(meeting)).slice(0, 1), ['on its way when the stream was replaced']);
});
