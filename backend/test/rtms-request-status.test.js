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
