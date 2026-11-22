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

// Meeting-scoped REST routes: the same proof that opens the WebSocket (a
// verified meeting-access cookie) is what lets a caller read a meeting by its
// Zoom id. Demo mode returns nothing from these, but the rule has to hold
// before storage is ever turned on.
test('meeting-by-Zoom-id routes only answer someone verified to be in that meeting', async () => {
  const { cookie } = await access(h.makeAppContext(h.meetingPayload({ mid: 'MEETING-A==' })));
  const get = (meetingId, suffix, headers = {}) => fetch(
    `${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}${suffix}`, { headers },
  );

  for (const suffix of ['', '/transcript', '/participant-events']) {
    assert.equal((await get('MEETING-A==', suffix, { cookie })).status, 200, `own meeting ${suffix}`);
    assert.equal((await get('MEETING-B', suffix, { cookie })).status, 403, `other meeting ${suffix}`);
    assert.equal((await get('MEETING-A==', suffix)).status, 401, `no cookie ${suffix}`);
    assert.equal((await get('MEETING-A==', suffix, { cookie: 'meetingAccess=garbage' })).status, 401, `bad cookie ${suffix}`);
  }
});

test('a signed-in user who is not in the meeting cannot read it by Zoom id', async () => {
  const session = generateToken({ userId: 'u1', zoomUserId: 'z1' });
  const res = await fetch(`${srv.base}/api/meetings/by-zoom-id/MEETING-A%3D%3D/transcript`, {
    headers: { cookie: `sessionToken=${session}` },
  });
  assert.equal(res.status, 401);
});

test('renaming a meeting needs a session and proof of being in that meeting', async () => {
  const { cookie } = await access(h.makeAppContext(h.meetingPayload({ mid: 'MEETING-A==' })));
  const session = `sessionToken=${generateToken({ userId: 'u1', zoomUserId: 'z1' })}`;
  const rename = (meetingId, headers) => fetch(
    `${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/topic`,
    { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ title: 'New' }) },
  );
  assert.equal((await rename('MEETING-A==', { cookie: `${cookie}; ${session}` })).status, 200);
  assert.equal((await rename('MEETING-A==', { cookie })).status, 401);            // guest: in the meeting, not signed in
  assert.equal((await rename('MEETING-A==', { cookie: session })).status, 401);   // signed in, not in the meeting
  assert.equal((await rename('MEETING-B', { cookie: `${cookie}; ${session}` })).status, 403);
});
