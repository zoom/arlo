// Integration: internal endpoints, debug routes, AI auth and input limits.
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateToken } = require('../src/services/auth');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const url = (p) => `${srv.base}${p}`;
const withKey = { 'x-arlo-internal-key': h.internalKey() };
const sessionCookie = () => ({ cookie: `sessionToken=${generateToken({ userId: 'u1', zoomUserId: 'z1' })}` });

test('internal broadcast requires the internal key', async () => {
  const body = { meetingId: 'm', segment: { text: 'x' } };
  assert.equal((await h.postJson(url('/api/rtms/broadcast'), body)).status, 401);
  assert.equal((await h.postJson(url('/api/rtms/broadcast'), body, { 'x-arlo-internal-key': 'wrong' })).status, 401);
  assert.equal((await h.postJson(url('/api/rtms/broadcast'), body, { 'x-arlo-internal': 'true' })).status, 401);
  assert.equal((await h.postJson(url('/api/rtms/broadcast'), body, withKey)).status, 200);
});

test('internal endpoints validate their payloads', async () => {
  assert.equal((await h.postJson(url('/api/rtms/broadcast'), { meetingId: 5, segment: {} }, withKey)).status, 400);
  assert.equal((await h.postJson(url('/api/rtms/participant-event'), { meetingId: 'm', events: [] })).status, 401);
  assert.equal((await h.postJson(url('/api/rtms/participant-event'), { meetingId: 'm', events: 'x' }, withKey)).status, 400);
});

test('status: internal may set any status, browsers only pause/resume', async () => {
  assert.equal((await h.postJson(url('/api/rtms/status'), { meetingId: 'm', status: 'rtms_stopped' })).status, 401);
  assert.equal((await h.postJson(url('/api/rtms/status'), { meetingId: 'm', status: 'rtms_stopped' }, withKey)).status, 200);
  const { cookie: access } = await h.postJson(url('/api/auth/meeting-access'), { appContext: h.makeAppContext(h.meetingPayload({ mid: 'm' })) });
  const inMeeting = { cookie: `${sessionCookie().cookie}; ${access}` };
  assert.equal((await h.postJson(url('/api/rtms/status'), { meetingId: 'm', status: 'rtms_paused' }, inMeeting)).status, 200);
  assert.equal((await h.postJson(url('/api/rtms/status'), { meetingId: 'm', status: 'rtms_stopped' }, inMeeting)).status, 403);
  assert.equal((await h.postJson(url('/api/rtms/status'), { meetingId: 'm', status: 'rtms_stopped' }, sessionCookie())).status, 403);
});

test('debug routes are off unless ENABLE_DEBUG_ROUTES=true', async () => {
  assert.equal((await fetch(url('/api/rtms/debug'))).status, 404);
});

test('webhook url_validation without plainToken is rejected', async () => {
  const res = await h.postJson(url('/api/rtms/webhook'), { event: 'endpoint.url_validation', payload: {} });
  assert.equal(res.status, 400);
});

test('AI endpoints require a session (no ?userId bypass)', async () => {
  assert.equal((await h.postJson(url('/api/ai/suggest'), { recentTranscript: 'hi' })).status, 401);
  assert.equal((await h.postJson(url('/api/ai/suggest?userId=1'), { recentTranscript: 'hi' })).status, 401);
});

test('AI endpoints reject oversized transcripts', async () => {
  const res = await h.postJson(url('/api/ai/suggest'), { recentTranscript: 'x'.repeat(250_000) }, sessionCookie());
  assert.equal(res.status, 413);
});

test('WebSocket rejects missing or bogus tokens with 1008', async () => {
  for (const q of ['?meeting_id=m', '?meeting_id=m&token=bogus']) {
    const ws = await h.wsRejection(`${srv.wsBase}${q}`);
    assert.equal(ws.code, 1008);
    assert.deepEqual(ws.messages, []);
  }
});

// Zoom signs the exact bytes it sends. Verifying a re-serialized copy of the
// parsed JSON rejects any payload whose bytes differ from JSON.stringify's
// output: escaped unicode (a meeting topic with an accent), spacing, key order.
test('webhook signatures are checked against the bytes Zoom sent', async () => {
  const crypto = require('node:crypto');
  const raw = '{"event":"rtms.request_status", "payload":{"id_field":{"meeting_uuid":"MEETING-RAW=="},"status":3,"note":"caf\\u00e9 \\/ r\\u00e9union"}}';
  assert.notEqual(JSON.stringify(JSON.parse(raw)), raw); // the case that used to fail
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = (body) => `v0=${crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_TOKEN).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  const send = (body, signature) => fetch(url('/api/rtms/webhook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zm-signature': signature, 'x-zm-request-timestamp': timestamp },
    body,
  });

  assert.equal((await send(raw, sign(raw))).status, 200);
  // A signature over the re-serialized form is not a signature over what was sent
  assert.equal((await send(raw, sign(JSON.stringify(JSON.parse(raw))))).status, 401);
});

// A session token in a URL ends up in proxy and access logs. The WebSocket is
// authenticated by cookies only.
test('WebSocket ignores a session token passed in the URL', async () => {
  const { generateToken } = require('../src/services/auth');
  const session = generateToken({ userId: 'u-query', zoomUserId: 'z-query' });
  const access = await h.postJson(url('/api/auth/meeting-access'), { appContext: h.makeAppContext(h.meetingPayload()) });
  const wsBase = url('/ws').replace('http', 'ws');

  const viaQuery = await h.openWs(`${wsBase}?meeting_id=m&token=${session}`, { cookie: access.cookie });
  await h.wait(100);
  viaQuery.socket.close();
  assert.equal(viaQuery.messages.find((m) => m.type === 'connected')?.data?.isGuest, true);

  const viaCookie = await h.openWs(`${wsBase}?meeting_id=m`, { cookie: `${access.cookie}; sessionToken=${session}` });
  await h.wait(100);
  viaCookie.socket.close();
  assert.equal(viaCookie.messages.find((m) => m.type === 'connected')?.data?.isGuest, false);
});

// Per-user data routes are stubs in demo mode, but they must already refuse
// anonymous callers, so that turning storage on later cannot expose data.
test('per-user data routes require a session', async () => {
  const paths = [
    '/api/meetings', '/api/meetings/some-id', '/api/meetings/some-id/transcript',
    '/api/meetings/some-id/participant-events', '/api/highlights',
    '/api/home/highlights', '/api/home/reminders', '/api/search?q=x',
  ];
  for (const path of paths) {
    assert.equal((await fetch(url(path))).status, 401, `${path} without a session`);
    assert.equal((await fetch(url(path), { headers: sessionCookie() })).status, 200, `${path} with a session`);
  }
});

test('a browser reports pause and resume only for the meeting its meeting-access cookie names', async () => {
  const meeting = 'PAUSE-A==';
  const access = async (mid) => (await h.postJson(url('/api/auth/meeting-access'), { appContext: h.makeAppContext(h.meetingPayload({ mid })) })).cookie;
  const here = await access(meeting);
  const elsewhere = await access('PAUSE-OTHER==');
  const session = sessionCookie().cookie;
  await h.postJson(url('/api/rtms/status'), { meetingId: meeting, status: 'rtms_started' }, withKey);
  const ws = await h.openWs(`${srv.base.replace('http', 'ws')}/ws?meeting_id=${encodeURIComponent(meeting)}`, { cookie: here });
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId: meeting } }));
  await h.wait(100);
  const post = (status, cookie, meetingId = meeting) => h.postJson(url('/api/rtms/status'), { meetingId, status }, cookie ? { cookie } : {});

  for (const status of ['rtms_paused', 'rtms_resumed']) {
    assert.equal((await post(status, null)).status, 401, `${status} with no cookies`);
    assert.equal((await post(status, here)).status, 401, `${status} not signed in`);
    assert.equal((await post(status, session)).status, 403, `${status} without meeting access`);
    assert.equal((await post(status, `${session}; ${elsewhere}`)).status, 403, `${status} with another meeting's access`);
    assert.equal((await post(status, `${session}; meetingAccess=not-a-token`)).status, 403, `${status} with a bad token`);
    // a session cookie does not stand in for meeting access
    assert.equal((await post(status, `${session}; meetingAccess=${session.split('=')[1]}`)).status, 403);
  }
  await h.wait(100);
  assert.deepEqual(ws.messages.filter((m) => m.type === 'meeting.status').map((m) => m.data.status), ['rtms_started']);

  assert.equal((await post('rtms_paused', `${session}; ${here}`)).status, 200);
  assert.equal((await post('rtms_resumed', `${session}; ${here}`)).status, 200);
  await h.wait(100);
  ws.socket.close();
  assert.deepEqual(ws.messages.filter((m) => m.type === 'meeting.status').map((m) => m.data.status), ['rtms_started', 'rtms_paused', 'rtms_resumed']);
  // the rtms service is not asked for a cookie
  assert.equal((await h.postJson(url('/api/rtms/status'), { meetingId: meeting, status: 'rtms_paused' }, withKey)).status, 200);
});
