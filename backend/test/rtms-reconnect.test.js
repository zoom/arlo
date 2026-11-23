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
