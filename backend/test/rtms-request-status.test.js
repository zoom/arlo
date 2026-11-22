// Integration: Zoom's rtms.request_status webhook (why a stream request did not
// start, e.g. status 3 = host denied) reaches the people in that meeting.
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const MEETING = 'MEETING-A==';

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

const requestStatus = (payload) => ({ event: 'rtms.request_status', event_ts: Date.now(), payload });
const received = (ws) => ws.messages.filter((m) => m.type === 'rtms.request_status');

test('a host denial (status 3) is delivered to the meeting, without the operator id', async () => {
  const ws = await joinMeeting();
  const res = await h.postWebhook(srv.base, requestStatus({
    id_field: { meeting_uuid: MEETING },
    operator_id: 'zoom-operator-1',
    status: 3,
    rtms_stream_id: 'stream-1',
  }));
  await h.wait(200);
  ws.socket.close();

  assert.equal(res.status, 200);
  const events = received(ws);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.meetingId, MEETING);
  assert.equal(events[0].data.status, 3);
  assert.equal(JSON.stringify(events[0]).includes('zoom-operator-1'), false);
});

test('an unsigned request_status is refused and not delivered', async () => {
  const ws = await joinMeeting();
  const res = await h.postWebhook(
    srv.base,
    requestStatus({ id_field: { meeting_uuid: MEETING }, status: 3 }),
    { sign: false },
  );
  await h.wait(200);
  ws.socket.close();

  assert.equal(res.status, 401);
  assert.equal(received(ws).length, 0);
});

test('unknown or malformed statuses are acknowledged but not delivered', async () => {
  const ws = await joinMeeting();
  const bad = [
    { id_field: { meeting_uuid: MEETING }, status: 99 },
    { id_field: { meeting_uuid: MEETING }, status: '3' },
    { id_field: { meeting_uuid: MEETING } },
    { status: 3 },
    { id_field: { meeting_uuid: 'x'.repeat(300) }, status: 3 },
  ];
  for (const payload of bad) {
    const res = await h.postWebhook(srv.base, requestStatus(payload));
    assert.equal(res.status, 200);
  }
  await h.wait(200);
  ws.socket.close();

  assert.equal(received(ws).length, 0);
});

// A panel opened (or reconnected) mid-meeting must learn from the server whether
// the stream is really running; the Zoom client's own status is not proof.
const setStatus = (meetingId, status) => h.postJson(
  `${srv.base}/api/rtms/status`,
  { meetingId, status },
  { 'x-arlo-internal-key': h.internalKey() },
);
const statuses = (ws) => ws.messages.filter((m) => m.type === 'meeting.status').map((m) => m.data.status);

test('a client that joins after the stream started is told it is running', async () => {
  await setStatus(MEETING, 'rtms_started');
  const ws = await joinMeeting();
  ws.socket.close();
  assert.deepEqual(statuses(ws), ['rtms_started']);
});

test('a client that joins while paused is told it is paused', async () => {
  await setStatus(MEETING, 'rtms_started');
  await setStatus(MEETING, 'rtms_paused');
  const ws = await joinMeeting();
  ws.socket.close();
  assert.deepEqual(statuses(ws), ['rtms_paused']);
});

test('after the stream stopped, a joining client is told nothing', async () => {
  await setStatus(MEETING, 'rtms_started');
  await setStatus(MEETING, 'rtms_stopped');
  const ws = await joinMeeting();
  ws.socket.close();
  assert.deepEqual(statuses(ws), []);
});

test('pause/resume reports cannot invent a stream that never started', async () => {
  await setStatus('MEETING-NEVER-STARTED', 'rtms_resumed');
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: 'MEETING-NEVER-STARTED' })) },
  );
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=x`, { cookie });
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: {} }));
  await h.wait(150);
  ws.socket.close();
  assert.deepEqual(statuses(ws), []);
});
