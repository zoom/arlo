// Arlo as a test proxy for Zoom's RTMS REST API: a script with an API token
// asks Arlo to start/stop a stream through Zoom's REST endpoint, then reads a
// timeline of what Zoom sent back. Calls to Zoom are stubbed.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' }); // nothing listens: forwarding fails fast

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateToken, encryptToken } = require('../src/services/auth');
const { userStore, tokenStore } = require('../src/lib/memoryStore');
const apiTokens = require('../src/lib/apiTokens');
const rtmsEvents = require('../src/lib/rtmsEvents');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); global.fetch = realFetch; });
test.beforeEach(() => { apiTokens._resetForTests(); rtmsEvents._resetForTests(); });

const realFetch = global.fetch;
let zoomCalls;
function stubZoom(respond = () => ({ status: 204 })) {
  zoomCalls = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith('https://api.zoom.us/')) return realFetch(input, init);
    const call = { url, method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    zoomCalls.push(call);
    const { status = 204, body } = respond(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
}
test.afterEach(() => { global.fetch = realFetch; });

let n = 0;
function user({ scopes = ['rtms:control', 'rtms:read'], zoomTokens = true } = {}) {
  n += 1;
  const record = userStore.upsert(`zoom-rest-${n}`, { email: 'x@example.test', displayName: 'X', avatarUrl: null });
  if (zoomTokens) {
    tokenStore.store(record.id, {
      accessToken: encryptToken(`zoom-access-${n}`), refreshToken: encryptToken('r'), expiresAt: new Date(Date.now() + 3_600_000), scopes: [],
    });
  }
  const { token } = apiTokens.create({ userId: record.id, zoomUserId: record.zoomUserId, scopes });
  const cookie = `sessionToken=${generateToken({ userId: record.id, zoomUserId: record.zoomUserId, exp: Date.now() + 60_000 })}`;
  return { record, token, cookie, zoomAccess: `zoom-access-${n}` };
}
const control = (auth, body) => fetch(`${srv.base}/api/rtms/start`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify(body),
});
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const events = async (token, query = '') => (await (await fetch(`${srv.base}/api/rtms/events${query}`, { headers: bearer(token) })).json()).events;
const webhook = (event, payload) => h.postWebhook(srv.base, { event, event_ts: Date.now(), payload });

test('a script starts a stream through Zoom\'s REST API with the user\'s own Zoom token', async () => {
  stubZoom();
  const u = user();
  const res = await control(bearer(u.token), { meetingId: '98765432101', action: 'start' });

  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, true);
  assert.equal(body.action, 'start');
  assert.match(body.note, /does not mean/i); // accepted is not started

  assert.equal(zoomCalls.length, 1);
  assert.equal(zoomCalls[0].method, 'PATCH');
  assert.equal(zoomCalls[0].url, 'https://api.zoom.us/v2/live_meetings/98765432101/rtms_app/status');
  assert.equal(zoomCalls[0].headers.Authorization, `Bearer ${u.zoomAccess}`);
  assert.deepEqual(zoomCalls[0].body, { action: 'start', settings: { client_id: 'test-client-id' } });
});

test('stop, pause and resume go through the same endpoint', async () => {
  stubZoom();
  const u = user();
  for (const action of ['stop', 'pause', 'resume']) {
    assert.equal((await control(bearer(u.token), { meetingId: '98765432101', action })).status, 202);
  }
  assert.deepEqual(zoomCalls.map((c) => c.body.action), ['stop', 'pause', 'resume']);
});

test('the signed-in panel can use it too, and the numeric meeting number is preferred over the UUID', async () => {
  stubZoom();
  const u = user();
  const res = await control({ cookie: u.cookie }, { meetingId: 'abc/DEF+gh==', meetingNumber: '98765432101', action: 'start' });
  assert.equal(res.status, 202);
  assert.match(zoomCalls[0].url, /\/live_meetings\/98765432101\//);
});

test('a meeting UUID is double-encoded when it contains a slash, as Zoom requires', async () => {
  stubZoom();
  const u = user();
  await control(bearer(u.token), { meetingId: 'ab/cd+ef==', action: 'start' });
  assert.equal(zoomCalls[0].url, 'https://api.zoom.us/v2/live_meetings/ab%252Fcd%252Bef%253D%253D/rtms_app/status');
});

test('bad input never reaches Zoom', async () => {
  stubZoom();
  const u = user();
  const bad = [
    { meetingId: '98765432101', action: 'destroy' },
    { action: 'start' },
    { meetingId: '', action: 'start' },
    { meetingId: '../users/me', action: 'start' },
    { meetingId: '123?x=1', action: 'start' },
    { meetingId: { $ne: null }, action: 'start' },
    { meetingId: 'x'.repeat(300), action: 'start' },
  ];
  for (const body of bad) assert.equal((await control(bearer(u.token), body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal(zoomCalls.length, 0);
});

test('when Zoom refuses, the script sees Zoom\'s status, code and message', async () => {
  stubZoom(() => ({ status: 400, body: { code: 3000, message: 'The app is not allowed to access meeting content.' } }));
  const u = user();
  const res = await control(bearer(u.token), { meetingId: '98765432101', action: 'start' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    accepted: false,
    action: 'start',
    zoom: { status: 400, code: 3000, message: 'The app is not allowed to access meeting content.' },
  });
});

test('a 401 from Zoom is reported as a gateway error, not as "you are signed out"', async () => {
  stubZoom(() => ({ status: 401, body: { code: 124, message: 'Invalid access token.' } }));
  const u = user();
  const res = await control(bearer(u.token), { meetingId: '98765432101', action: 'start' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).zoom.status, 401);
});

test('without Zoom tokens the user is told to sign in again', async () => {
  stubZoom();
  const u = user({ zoomTokens: false });
  const res = await control(bearer(u.token), { meetingId: '98765432101', action: 'start' });
  assert.equal(res.status, 409);
  assert.equal(zoomCalls.length, 0);
});

test('the timeline shows the request and everything Zoom and Arlo reported for that user\'s meeting', async () => {
  stubZoom();
  const u = user();
  const MEETING = 'TIMELINE-MEETING==';
  await control(bearer(u.token), { meetingId: '98765432101', action: 'start' });
  await webhook('rtms.request_status', { id_field: { meeting_uuid: MEETING }, operator_id: u.record.zoomUserId, status: 3 });
  await webhook('meeting.rtms_started', { meeting_uuid: MEETING, operator_id: u.record.zoomUserId, rtms_stream_id: 's1', server_urls: 'wss://x' });
  await h.postJson(`${srv.base}/api/rtms/status`, { meetingId: MEETING, status: 'rtms_started' }, { 'x-arlo-internal-key': h.internalKey() });
  await webhook('meeting.rtms_interrupted', { meeting_uuid: MEETING, rtms_stream_id: 's1' });
  await webhook('meeting.rtms_stopped', { meeting_uuid: MEETING, rtms_stream_id: 's1', stop_reason: 6 });

  const timeline = await events(u.token);
  assert.deepEqual(timeline.map((e) => e.event), [
    'rest.request', 'rtms.request_status', 'meeting.rtms_started', 'arlo.stream_joined', 'meeting.rtms_interrupted', 'meeting.rtms_stopped',
  ]);
  assert.deepEqual(timeline[0].detail, { action: 'start', meetingId: '98765432101', accepted: true, zoomStatus: 204 });
  assert.equal(timeline[1].detail.status, 3);
  assert.match(timeline[1].detail.meaning, /host denied/i);
  assert.equal(timeline[2].meetingUuid, MEETING);
  assert.equal(timeline[5].detail.stopReason, 6);
  for (const entry of timeline) assert.ok(!Number.isNaN(Date.parse(entry.at)));
  // identifiers Arlo does not need to hand back are not in the timeline
  assert.equal(JSON.stringify(timeline).includes('wss://x'), false);
  assert.equal(JSON.stringify(timeline).includes(u.zoomAccess), false);
});

test('a user only sees their own meetings\' events', async () => {
  stubZoom();
  const ana = user();
  const ben = user();
  await webhook('meeting.rtms_started', { meeting_uuid: 'ANA-MEETING', operator_id: ana.record.zoomUserId, rtms_stream_id: 's1' });
  await webhook('meeting.rtms_stopped', { meeting_uuid: 'ANA-MEETING', rtms_stream_id: 's1' });
  await webhook('meeting.rtms_stopped', { meeting_uuid: 'NOBODYS-MEETING', rtms_stream_id: 's9' });

  assert.equal((await events(ana.token)).length, 2);
  assert.deepEqual(await events(ben.token), []);
});

test('the timeline can be read from a point in time', async () => {
  stubZoom();
  const u = user();
  await control(bearer(u.token), { meetingId: '98765432101', action: 'start' });
  const first = (await events(u.token))[0];
  await h.wait(15);
  await control(bearer(u.token), { meetingId: '98765432101', action: 'stop' });

  const later = await events(u.token, `?since=${encodeURIComponent(first.at)}`);
  assert.deepEqual(later.map((e) => e.detail.action), ['stop']);
  assert.equal((await fetch(`${srv.base}/api/rtms/events?since=not-a-date`, { headers: bearer(u.token) })).status, 400);
});

test('control and read are separate scopes', async () => {
  stubZoom();
  const controlOnly = user({ scopes: ['rtms:control'] });
  assert.equal((await control(bearer(controlOnly.token), { meetingId: '98765432101', action: 'start' })).status, 202);
  assert.equal((await fetch(`${srv.base}/api/rtms/events`, { headers: bearer(controlOnly.token) })).status, 403);
});

test('a refused request is on the timeline with Zoom\'s reason', async () => {
  stubZoom(() => ({ status: 404, body: { code: 3001, message: 'Meeting does not exist.' } }));
  const u = user();
  await control(bearer(u.token), { meetingId: '98765432101', action: 'start' });
  const [entry] = await events(u.token);
  assert.deepEqual(entry.detail, { action: 'start', meetingId: '98765432101', accepted: false, zoomStatus: 404, zoomCode: 3001, zoomMessage: 'Meeting does not exist.' });
});
