// Integration: a panel that opens late (or reconnects) gets what was said so
// far, only for the meeting it is verified to be in, and only while that
// meeting's data is held.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', MEETING_FLUSH_GRACE_MS: '200' });

const test = require('node:test');
const assert = require('node:assert/strict');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const internal = { 'x-arlo-internal-key': h.internalKey() };
const say = (meetingId, seqNo, text) => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, segment: { seqNo, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: seqNo * 1000, tEndMs: seqNo * 1000 } },
  internal,
);
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
const events = (meetingId, list) => h.postJson(`${srv.base}/api/rtms/participant-event`, { meetingId, events: list }, internal);

async function cookieFor(meetingId) {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
  );
  return cookie;
}
async function history(meetingId, path, cookie) {
  const res = await fetch(`${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/${path}`, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
}
async function openPanel(meetingId, cookie) {
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, { cookie });
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId } }));
  await h.wait(100);
  return ws;
}

test('someone who opens Arlo late gets what was said before they arrived', async () => {
  const meeting = 'REPLAY-A==';
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'We ship on Friday.');
  await say(meeting, 2, 'Agreed.');

  const cookie = await cookieFor(meeting);
  const transcript = await history(meeting, 'transcript', cookie);
  assert.equal(transcript.status, 200);
  assert.deepEqual(transcript.body.segments.map((s) => s.text), ['We ship on Friday.', 'Agreed.']);
  assert.deepEqual(transcript.body.segments[0], {
    seqNo: 1, text: 'We ship on Friday.', speakerId: '7', speakerLabel: 'Ana', tStartMs: 1000, tEndMs: 1000,
  });
});

test('the timeline is replayed too, and live events carry the same ids', async () => {
  const meeting = 'REPLAY-B==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started' });
  await events(meeting, [{ eventType: 'joined', participantName: 'Ben', participantId: '12', timestamp: 1700000000000 }]);
  await h.wait(150);
  ws.socket.close();

  const live = ws.messages.filter((m) => m.type === 'participant.event').map((m) => m.data.event);
  const stored = (await history(meeting, 'participant-events', cookie)).body.events;
  assert.deepEqual(stored.map((e) => e.eventType), ['transcription_started', 'joined']);
  assert.deepEqual(live.map((e) => e.id), stored.map((e) => e.id));
  assert.match(stored[0].id, /^[0-9a-f-]{36}$/);
});

test('one meeting never sees another meeting\'s transcript', async () => {
  await status('REPLAY-C==', { status: 'rtms_started' });
  await say('REPLAY-C==', 1, 'Customer A pricing is confidential.');

  const otherCookie = await cookieFor('REPLAY-D==');
  assert.equal((await history('REPLAY-C==', 'transcript', otherCookie)).status, 403);
  assert.deepEqual((await history('REPLAY-D==', 'transcript', otherCookie)).body.segments, []);
});

test('a segment that cannot be stored is refused, not broadcast', async () => {
  const res = await h.postJson(`${srv.base}/api/rtms/broadcast`, { meetingId: 'REPLAY-E==', segment: { seqNo: 1 } }, internal);
  assert.equal(res.status, 400);
});
