// Integration: stream failover and reconnection as the backend sees it. The
// rtms service owns the connection to Zoom; the backend forwards Zoom's
// lifecycle webhooks to it and relays what it reports to the meeting's panels.
const http = require('node:http');
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const test = require('node:test');
const assert = require('node:assert/strict');

const MEETING = 'MEETING-R==';
let srv;
let fakeRtms;
const forwarded = []; // what the rtms service received from the backend

test.before(async () => {
  srv = await h.startServer();
  fakeRtms = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      forwarded.push({ url: req.url, key: req.headers['x-arlo-internal-key'], body: JSON.parse(raw) });
      res.writeHead(200).end('OK');
    });
  });
  await new Promise((resolve) => { fakeRtms.listen(0, '127.0.0.1', resolve); });
  process.env.RTMS_SERVICE_URL = `http://127.0.0.1:${fakeRtms.address().port}`;
});
test.after(() => {
  srv.server.closeAllConnections?.();
  srv.server.close();
  fakeRtms.close();
});

async function joinMeeting() {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: MEETING })) },
  );
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(MEETING)}`, { cookie });
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId: MEETING } }));
  await h.wait(150);
  return ws;
}

const setStatus = (body, headers = { 'x-arlo-internal-key': h.internalKey() }) => h.postJson(
  `${srv.base}/api/rtms/status`,
  { meetingId: MEETING, ...body },
  headers,
);
const statusMessages = (ws) => ws.messages.filter((m) => m.type === 'meeting.status').map((m) => m.data);

test('meeting.rtms_interrupted is forwarded to the rtms service, which decides what the meeting is told', async () => {
  await setStatus({ status: 'rtms_started' });
  const ws = await joinMeeting();
  forwarded.length = 0;
  const res = await h.postWebhook(srv.base, {
    event: 'meeting.rtms_interrupted',
    event_ts: 1700000000000,
    payload: { meeting_uuid: MEETING, rtms_stream_id: 'stream-1', server_urls: 'wss://zoom.example' },
  });
  await h.wait(200);
  ws.socket.close();

  assert.equal(res.status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, '/webhook');
  assert.equal(forwarded[0].key, h.internalKey());
  assert.equal(forwarded[0].body.event, 'meeting.rtms_interrupted');
  assert.equal(forwarded[0].body.event_ts, 1700000000000);
  assert.equal(forwarded[0].body.payload.server_urls, 'wss://zoom.example');
  // The backend itself says nothing: a late webhook must not undo a finished rejoin
  assert.deepEqual(statusMessages(ws).map((d) => d.status), ['rtms_started']);
});

test('an unsigned rtms_interrupted is refused and not forwarded', async () => {
  forwarded.length = 0;
  const res = await h.postWebhook(
    srv.base,
    { event: 'meeting.rtms_interrupted', payload: { meeting_uuid: MEETING, rtms_stream_id: 'stream-1' } },
    { sign: false },
  );
  assert.equal(res.status, 401);
  assert.equal(forwarded.length, 0);
});

test('a rejoined stream is a running stream to the panels, including one that opens later', async () => {
  await setStatus({ status: 'rtms_started' });
  const ws = await joinMeeting();
  await setStatus({ status: 'rtms_interrupted' });
  await setStatus({ status: 'rtms_reconnected' });
  await h.wait(200);
  ws.socket.close();
  assert.deepEqual(statusMessages(ws).map((d) => d.status), ['rtms_started', 'rtms_interrupted', 'rtms_started']);

  const later = await joinMeeting();
  later.socket.close();
  assert.deepEqual(statusMessages(later).map((d) => d.status), ['rtms_started']);
});

test('a rejoin adds no "transcription started" line to the meeting timeline', async () => {
  await setStatus({ status: 'rtms_started' });
  const ws = await joinMeeting();
  await setStatus({ status: 'rtms_reconnected' });
  await h.wait(200);
  ws.socket.close();
  assert.equal(ws.messages.filter((m) => m.type === 'participant.event').length, 0);
});

test('a stream ended by a fault is marked as such, an ordinary stop is not', async () => {
  await setStatus({ status: 'rtms_started' });
  const ws = await joinMeeting();
  await setStatus({ status: 'rtms_stopped', fault: true });
  await setStatus({ status: 'rtms_started' });
  await setStatus({ status: 'rtms_stopped' });
  await setStatus({ status: 'rtms_started' });
  await setStatus({ status: 'rtms_stopped', fault: 'true' }); // must be the boolean
  await h.wait(200);
  ws.socket.close();

  const stops = statusMessages(ws).filter((d) => d.status === 'rtms_stopped');
  assert.deepEqual(stops.map((d) => d.fault === true), [true, false, false]);
  assert.equal('fault' in stops[1], false);
});

test('a browser cannot report a reconnect or a fault', async () => {
  const res = await setStatus({ status: 'rtms_reconnected' }, {});
  assert.equal(res.status, 401);
  const stop = await setStatus({ status: 'rtms_stopped', fault: true }, {});
  assert.equal(stop.status, 401);
});

// ---------------------------------------------------------------------------
// Who brought Arlo in: each panel is told its own role
// ---------------------------------------------------------------------------

const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');

let userCount = 0;
/** A user who signed in to Arlo. Returns their Zoom id and a session cookie. */
function arloUser(displayName) {
  userCount += 1;
  const zoomUserId = `zoom-presence-${userCount}`;
  const user = userStore.upsert(zoomUserId, { email: `${zoomUserId}@example.test`, displayName, avatarUrl: null });
  return { user, zoomUserId, session: `sessionToken=${generateToken({ userId: user.id, zoomUserId })}` };
}
/** Open a panel in a meeting, signed in (pass a session cookie) or not. */
async function openPanel(meetingId, session) {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
  );
  const ws = await h.openWs(
    `${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`,
    { cookie: session ? `${cookie}; ${session}` : cookie },
  );
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId } }));
  await h.wait(150);
  return ws;
}
const statusFor = (meetingId, body) => h.postJson(
  `${srv.base}/api/rtms/status`, { meetingId, ...body }, { 'x-arlo-internal-key': h.internalKey() },
);
const arloStates = (ws) => ws.messages.filter((m) => m.type === 'arlo.state').map((m) => m.data);
const lastState = (ws) => arloStates(ws).at(-1);

test('the user whose stream started is told they are the owner, everyone else that they are a participant', async () => {
  const meeting = 'PRESENCE-A==';
  const ana = arloUser('Ana Ruiz');
  const ben = arloUser('Ben Okafor');
  const owner = await openPanel(meeting, ana.session);
  const other = await openPanel(meeting, ben.session);
  const guest = await openPanel(meeting);

  // before anything started: Arlo is not in the meeting
  assert.deepEqual(
    { ...lastState(guest) },
    { meetingId: meeting, present: false, paused: false, role: 'participant', ownerName: null, whoCanAsk: 'owner', notesShared: false },
  );

  await statusFor(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  await h.wait(150);
  for (const ws of [owner, other, guest]) ws.socket.close();

  assert.deepEqual(lastState(owner), {
    meetingId: meeting, present: true, paused: false, myStreamPaused: false, myStreamLive: true, role: 'owner', ownerName: 'Ana Ruiz', whoCanAsk: 'owner', notesShared: false,
  });
  assert.equal(lastState(other).role, 'participant');
  assert.equal(lastState(guest).role, 'participant');
  assert.equal(lastState(guest).ownerName, 'Ana Ruiz');
  assert.equal(lastState(guest).present, true);
});

test('a panel that opens later is told its role on connect and again when it subscribes', async () => {
  const meeting = 'PRESENCE-B==';
  const ana = arloUser('Ana Ruiz');
  await statusFor(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });

  const owner = await openPanel(meeting, ana.session);
  const guest = await openPanel(meeting);
  owner.socket.close();
  guest.socket.close();

  assert.deepEqual(arloStates(owner).map((s) => s.role), ['owner', 'owner']);
  assert.deepEqual(arloStates(guest).map((s) => s.role), ['participant', 'participant']);
  assert.equal(arloStates(owner)[0].present, true);
});

test('a second user starting a stream of their own becomes an owner too, though the meeting\'s status does not change', async () => {
  const meeting = 'PRESENCE-C==';
  const ana = arloUser('Ana Ruiz');
  const ben = arloUser('Ben Okafor');
  await statusFor(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  const second = await openPanel(meeting, ben.session);
  assert.equal(lastState(second).role, 'participant');

  await statusFor(meeting, { status: 'rtms_started', streamId: 's2', operatorId: ben.zoomUserId });
  await h.wait(150);
  assert.equal(lastState(second).role, 'owner');
  assert.equal(lastState(second).ownerName, 'Ana Ruiz'); // the transcript still comes from the first stream
  assert.deepEqual(statusMessages(second).map((d) => d.status), ['rtms_started']);

  // their stream stopping does not stop the meeting, and they stay an owner
  await statusFor(meeting, { status: 'rtms_stopped', streamId: 's2' });
  await h.wait(150);
  second.socket.close();
  assert.deepEqual(statusMessages(second).map((d) => d.status), ['rtms_started']);
  assert.equal(lastState(second).role, 'owner');
  assert.equal(lastState(second).present, true);
});

test('an operator who never signed in to Arlo makes nobody the owner', async () => {
  const meeting = 'PRESENCE-D==';
  const ben = arloUser('Ben Okafor');
  const ws = await openPanel(meeting, ben.session);
  await statusFor(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'zoom-user-without-arlo' });
  await h.wait(150);
  ws.socket.close();
  assert.equal(lastState(ws).role, 'participant');
  assert.equal(lastState(ws).ownerName, null);
  assert.equal(lastState(ws).present, true);
});

test('pause and stop reach the panels as Arlo\'s state; the owner stays the owner through a stop', async () => {
  const meeting = 'PRESENCE-E==';
  const ana = arloUser('Ana Ruiz');
  const owner = await openPanel(meeting, ana.session);
  await statusFor(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  await statusFor(meeting, { status: 'rtms_paused', streamId: 's1' });
  await h.wait(100);
  assert.deepEqual([lastState(owner).present, lastState(owner).paused], [true, true]);

  await statusFor(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await h.wait(100);
  owner.socket.close();
  assert.deepEqual(
    [lastState(owner).present, lastState(owner).paused, lastState(owner).role],
    [false, false, 'owner'],
  );
});

test('a change of who can ask is sent to every panel of the meeting', async () => {
  const { getArloPresence } = require('../src/services/arloPresence');
  const { broadcastArloState } = require('../src/services/websocket');
  const meeting = 'PRESENCE-F==';
  const ana = arloUser('Ana Ruiz');
  await statusFor(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  const guest = await openPanel(meeting);

  assert.equal(getArloPresence().setWhoCanAsk(meeting, ana.user.id, 'anyone'), true);
  assert.equal(broadcastArloState(meeting), 1);
  await h.wait(100);
  guest.socket.close();
  assert.equal(lastState(guest).whoCanAsk, 'anyone');
  assert.equal(broadcastArloState('PRESENCE-NOBODY=='), 0);
});

test('a stop because the meeting ended reaches the panels marked as such, and after it nobody is the owner', async () => {
  const meeting = 'PRESENCE-G==';
  const ana = arloUser('Ana Ruiz');
  const owner = await openPanel(meeting, ana.session);
  await statusFor(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  await statusFor(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await statusFor(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  await statusFor(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: 'true' }); // must be the boolean
  await statusFor(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  await statusFor(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  await h.wait(200);
  owner.socket.close();

  const stops = statusMessages(owner).filter((d) => d.status === 'rtms_stopped');
  assert.deepEqual(stops.map((d) => d.meetingEnded === true), [false, false, true]);
  assert.equal('meetingEnded' in stops[0], false);
  // the meeting's data is gone, and with it who owned the notes
  assert.equal(lastState(owner).role, 'participant');
  assert.equal(lastState(owner).present, false);
  // the order matters to the panel: "ended" first, then the state after it
  const types = owner.messages.map((m) => m.type);
  assert.ok(types.lastIndexOf('meeting.status') < types.lastIndexOf('arlo.state'));
});

test('sendToMeetingSockets builds a message per socket, skips null, and survives a socket that cannot send', async () => {
  const { sendToMeetingSockets } = require('../src/services/websocket');
  const meeting = 'PRESENCE-H==';
  const ana = arloUser('Ana Ruiz');
  const signedIn = await openPanel(meeting, ana.session);
  const guest = await openPanel(meeting);

  const seen = [];
  const sent = sendToMeetingSockets(meeting, (ws) => {
    seen.push(ws.userId);
    if (!ws.userId) return null; // nothing for the guest
    return { type: 'test.private', data: { for: ws.userId } };
  });
  const afterThrow = sendToMeetingSockets(meeting, (ws) => {
    if (ws.userId) throw new Error('builder failed for one socket');
    return { type: 'test.second', data: {} };
  });
  await h.wait(100);
  signedIn.socket.close();
  guest.socket.close();

  assert.equal(sent, 1);
  assert.deepEqual(seen.sort(), [ana.user.id, null].sort());
  assert.deepEqual(signedIn.messages.filter((m) => m.type === 'test.private').map((m) => m.data.for), [ana.user.id]);
  assert.equal(guest.messages.some((m) => m.type === 'test.private'), false);
  assert.equal(afterThrow, 1);
  assert.equal(guest.messages.some((m) => m.type === 'test.second'), true);
  assert.equal(sendToMeetingSockets('PRESENCE-NOBODY==', () => ({ type: 'x' })), 0);
  assert.equal(sendToMeetingSockets(meeting, 'not a function'), 0);
});
