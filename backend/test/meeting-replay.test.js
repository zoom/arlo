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

test('the meeting ending deletes its transcript and timeline, and a line still in flight is not kept', async () => {
  const meeting = 'REPLAY-F==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'Said during the meeting.');
  assert.equal((await history(meeting, 'transcript', cookie)).body.segments.length, 1);

  await status(meeting, { status: 'rtms_stopped', meetingEnded: true });
  assert.deepEqual((await history(meeting, 'transcript', cookie)).body.segments, []);
  assert.deepEqual((await history(meeting, 'participant-events', cookie)).body.events, []);

  const straggler = await say(meeting, 2, 'Arrived after the end.');
  assert.equal(straggler.status, 200);
  assert.equal(straggler.body.stored, false);
  assert.deepEqual((await history(meeting, 'transcript', cookie)).body.segments, []);
});

test('"meeting ended" is only believed together with a stop', async () => {
  const meeting = 'REPLAY-I==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'Still running.');
  await status(meeting, { status: 'rtms_paused', meetingEnded: true });
  await status(meeting, { status: 'rtms_started', meetingEnded: true });
  assert.equal((await history(meeting, 'transcript', cookie)).body.segments.length, 1);
});

test('a browser cannot make the server flush a meeting, signed in or not', async () => {
  const { generateToken } = require('../src/services/auth');
  const signedIn = { cookie: `sessionToken=${generateToken({ userId: 'u1', zoomUserId: 'z1' })}` };
  const meeting = 'REPLAY-H==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'Still here.');
  const post = (body, headers) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId: meeting, ...body }, headers);

  assert.equal((await post({ status: 'rtms_stopped', meetingEnded: true })).status, 401);
  assert.equal((await post({ status: 'rtms_stopped', meetingEnded: true }, signedIn)).status, 403);
  // pause is a status a browser may report; "meeting ended" riding on it is ignored
  const inMeeting = { cookie: `${signedIn.cookie}; ${cookie}` };
  assert.equal((await post({ status: 'rtms_paused', meetingEnded: true }, inMeeting)).status, 200);
  assert.equal((await post({ status: 'rtms_resumed', meetingEnded: true }, inMeeting)).status, 200);
  await h.wait(400);

  const kept = (await history(meeting, 'transcript', cookie)).body.segments;
  assert.deepEqual(kept.map((s) => s.text), ['Still here.']);
  // and the browser's report added nothing to what is stored
  const stored = (await history(meeting, 'participant-events', cookie)).body.events;
  assert.deepEqual(stored.map((e) => e.eventType), ['transcription_started']);
});

test('history is never cached by the browser or a proxy', async () => {
  const meeting = 'REPLAY-L==';
  const cookie = await cookieFor(meeting);
  for (const path of ['transcript', 'participant-events']) {
    const res = await fetch(`${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meeting)}/${path}`, { headers: { cookie } });
    assert.equal(res.headers.get('cache-control'), 'no-store', path);
  }
});

test('Zoom\'s "stopped, meeting ended" webhook flushes even when the rtms service cannot be reached', async () => {
  // RTMS_SERVICE_URL points at a closed port in this file, so forwarding fails
  const meeting = 'REPLAY-M==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'The rtms service is being restarted.');

  const res = await h.postWebhook(srv.base, {
    event: 'meeting.rtms_stopped', event_ts: Date.now(),
    payload: { meeting_uuid: meeting, rtms_stream_id: 'stream-1', stop_reason: 6 },
  });
  await h.wait(150);
  ws.socket.close();

  assert.equal(res.status, 200);
  assert.deepEqual((await history(meeting, 'transcript', cookie)).body.segments, []);
  const statuses = ws.messages.filter((m) => m.type === 'meeting.status').map((m) => m.data.status);
  assert.equal(statuses.at(-1), 'rtms_stopped');
});

test('a stop webhook that is not "meeting ended" keeps the data while a panel is connected', async () => {
  const meeting = 'REPLAY-N==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'The host stopped the stream.');
  await h.postWebhook(srv.base, {
    event: 'meeting.rtms_stopped', event_ts: Date.now(),
    payload: { meeting_uuid: meeting, rtms_stream_id: 'stream-1', stop_reason: 1 },
  });
  await h.wait(400);
  assert.equal((await history(meeting, 'transcript', cookie)).body.segments.length, 1);
  ws.socket.close();
});

test('a panel that unsubscribes and subscribes again still counts as connected', async () => {
  const meeting = 'REPLAY-O==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'Still watched.');
  ws.socket.send(JSON.stringify({ type: 'unsubscribe' }));
  await h.wait(50);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId: meeting } }));
  await h.wait(100);

  await status(meeting, { status: 'rtms_stopped' });
  await h.wait(500);
  assert.equal((await history(meeting, 'transcript', cookie)).body.segments.length, 1);
  ws.socket.close();
});

test('two panels: one closing keeps the data, the last one closing flushes it', async () => {
  const meeting = 'REPLAY-P==';
  const cookie = await cookieFor(meeting);
  const first = await openPanel(meeting, cookie);
  const second = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'Two people are watching.');
  await status(meeting, { status: 'rtms_stopped' });

  first.socket.close();
  await h.wait(500);
  assert.equal((await history(meeting, 'transcript', cookie)).body.segments.length, 1);

  second.socket.close();
  await h.wait(600);
  assert.deepEqual((await history(meeting, 'transcript', cookie)).body.segments, []);
});

test('lines for a meeting the server was never told about are kept, then flushed after a stop with no panel', async () => {
  // e.g. the backend restarted mid-meeting and missed "started"
  const meeting = 'REPLAY-J==';
  const cookie = await cookieFor(meeting);
  await say(meeting, 1, 'The backend restarted and missed the start.');
  await h.wait(400); // longer than the 200ms grace period: the stream counts as running
  assert.equal((await history(meeting, 'transcript', cookie)).body.segments.length, 1);

  await status(meeting, { status: 'rtms_stopped' });
  await h.wait(600);
  assert.deepEqual((await history(meeting, 'transcript', cookie)).body.segments, []);
});

test('a stop inside the meeting keeps the transcript while a panel is connected, and a restart continues it', async () => {
  const meeting = 'REPLAY-K==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'Said before the stop.');

  await status(meeting, { status: 'rtms_stopped' });
  await h.wait(400); // longer than the 200ms grace period: a panel is still connected
  assert.equal((await history(meeting, 'transcript', cookie)).body.segments.length, 1);

  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'Said after the restart.');
  assert.deepEqual(
    (await history(meeting, 'transcript', cookie)).body.segments.map((s) => s.text),
    ['Said before the stop.', 'Said after the restart.'],
  );
  ws.socket.close();
});

test('stream stopped, then the last panel closes: the transcript is deleted after the grace period', async () => {
  const meeting = 'REPLAY-G==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'Nobody is left to read this.');
  await status(meeting, { status: 'rtms_stopped' });
  await h.wait(400);
  assert.equal((await history(meeting, 'transcript', cookie)).body.segments.length, 1);

  ws.socket.close();
  await h.wait(600);
  assert.deepEqual((await history(meeting, 'transcript', cookie)).body.segments, []);
});

test('after the meeting ended, a late timeline event is not kept either, and a start report does not bring the meeting back', async () => {
  const meeting = 'REPLAY-Q==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started' });
  await say(meeting, 1, 'During the meeting.');
  await status(meeting, { status: 'rtms_stopped', meetingEnded: true });

  await events(meeting, [{ eventType: 'left', participantName: 'Ben', participantId: '12', timestamp: 1700000000000 }]);
  assert.deepEqual((await history(meeting, 'participant-events', cookie)).body.events, []);

  // a meeting that ended does not start again: a late start report stores nothing
  await status(meeting, { status: 'rtms_started' });
  await status(meeting, { status: 'rtms_reconnected' });
  assert.deepEqual((await history(meeting, 'participant-events', cookie)).body.events, []);
});

test('panels are told the meeting\'s stream stopped before its data is flushed', async () => {
  const meeting = 'REPLAY-R==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started' });
  await status(meeting, { status: 'rtms_stopped', meetingEnded: true });
  await h.wait(150);
  ws.socket.close();

  const types = ws.messages
    .filter((m) => m.type === 'meeting.status' || m.type === 'participant.event')
    .map((m) => (m.type === 'meeting.status' ? m.data.status : m.data.event.eventType));
  assert.deepEqual(types, ['rtms_started', 'transcription_started', 'rtms_stopped', 'transcription_stopped']);
});
