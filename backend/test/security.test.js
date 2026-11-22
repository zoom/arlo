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
  assert.equal((await h.postJson(url('/api/rtms/status'), { meetingId: 'm', status: 'rtms_paused' }, sessionCookie())).status, 200);
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
