// Integration: guest/participant access via Zoom App Context, end to end
// (HTTP verification -> meeting-access cookie -> WebSocket bound to one meeting).
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateToken } = require('../src/services/auth');
const { issueMeetingAccessToken } = require('../src/services/zoomAppContext');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const access = (appContext, headers) => h.postJson(`${srv.base}/api/auth/meeting-access`, { appContext }, headers);
const broadcast = (meetingId, text, seqNo = 1) => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, segment: { speakerLabel: 'Test', text, seqNo, tStartMs: 0, tEndMs: 0 } },
  { 'x-arlo-internal-key': h.internalKey() },
);

test('valid context grants guest access with an httpOnly cookie', async () => {
  const res = await access(h.makeAppContext(h.meetingPayload()));
  assert.equal(res.status, 200);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.isGuest, true);
  assert.equal(res.body.meetingId, 'MEETING-A==');
  assert.match(res.cookie, /^meetingAccess=/);
});

test('invalid contexts are refused with a reason and no cookie', async () => {
  const bad = [
    h.makeAppContext(h.meetingPayload({ exp: Date.now() - 1000 })),
    h.makeAppContext(h.meetingPayload({ typ: 'panel', mid: undefined })),
    h.makeAppContext(h.meetingPayload(), { secret: 'wrong-secret' }),
    h.makeAppContext(h.meetingPayload(), { tamper: true }),
    'AAAA',
    undefined,
    'A'.repeat(9000),
  ];
  for (const ctx of bad) {
    const res = await access(ctx);
    assert.equal(res.status, 403);
    assert.equal(typeof res.body.reason, 'string');
    assert.equal(res.cookie, '');
  }
});

test('a signed-in user who verifies is not marked as guest', async () => {
  const session = generateToken({ userId: 'u1', zoomUserId: 'z1' });
  const res = await access(h.makeAppContext(h.meetingPayload()), { cookie: `sessionToken=${session}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.isGuest, false);
});

test('guest WebSocket only receives its own meeting, even when asking for another', async () => {
  const { cookie } = await access(h.makeAppContext(h.meetingPayload()));
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=MEETING-B`, { cookie });
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId: 'MEETING-B' } }));
  await h.wait(150);

  await broadcast('MEETING-A==', 'hello A');
  await broadcast('MEETING-B', 'secret B', 2);
  await h.wait(200);
  ws.socket.close();

  const connected = ws.messages.find((m) => m.type === 'connected');
  assert.equal(connected?.data?.meetingId, 'MEETING-A==');
  const texts = ws.messages.filter((m) => m.type === 'transcript.segment').map((m) => m.data.segment.text);
  assert.deepEqual(texts, ['hello A']);
});

test('WebSocket without meeting access is closed with 1008 and gets no data', async () => {
  const anon = await h.wsRejection(`${srv.wsBase}?meeting_id=MEETING-A==`);
  assert.equal(anon.code, 1008);
  assert.deepEqual(anon.messages, []);

  const session = generateToken({ userId: 'u1', zoomUserId: 'z1' });
  const sessionOnly = await h.wsRejection(`${srv.wsBase}?meeting_id=MEETING-A==`, { cookie: `sessionToken=${session}` });
  assert.equal(sessionOnly.code, 1008);
  assert.deepEqual(sessionOnly.messages, []);
});

test('dev auth bypass only works when explicitly enabled', async () => {
  const session = generateToken({ userId: 'u1', zoomUserId: 'z1' });
  process.env.ALLOW_DEV_AUTH_BYPASS = 'true';
  try {
    const ws = await h.openWs(`${srv.wsBase}?meeting_id=DEV-M`, { cookie: `sessionToken=${session}` });
    assert.equal(ws.open, true);
    ws.socket.close();
  } finally {
    delete process.env.ALLOW_DEV_AUTH_BYPASS;
  }
});

test('a meeting-access token cannot be replayed as a session', async () => {
  const accessToken = issueMeetingAccessToken({ meetingId: 'MEETING-A==' });
  const me = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: `sessionToken=${accessToken}` } });
  assert.notEqual(me.status, 200);
  const ai = await h.postJson(`${srv.base}/api/ai/suggest`, {}, { cookie: `sessionToken=${accessToken}` });
  assert.equal(ai.status, 401);
});
