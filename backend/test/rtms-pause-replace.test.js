// Integration: pause is per stream (the meeting is paused only when every
// running stream is), and a stream its user replaces with a new one is not
// shown as a stop while the new one is being joined.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', MEETING_FLUSH_GRACE_MS: '200', AI_ENABLED: 'false' });

const test = require('node:test');
const assert = require('node:assert/strict');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { getMeetingStreams } = require('../src/services/meetingStreams');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const internal = { 'x-arlo-internal-key': h.internalKey() };
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
let lineNo = 0;
function say(meetingId, streamId, text) {
  lineNo += 1;
  return h.postJson(
    `${srv.base}/api/rtms/broadcast`,
    { meetingId, streamId, segment: { seqNo: lineNo, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: lineNo * 60_000, tEndMs: lineNo * 60_000 } },
    internal,
  );
}

function person(zoomUserId, displayName) {
  const user = userStore.upsert(zoomUserId, { email: `${zoomUserId}@example.test`, displayName, avatarUrl: null });
  return { user, zoomUserId, session: `sessionToken=${generateToken({ userId: user.id, zoomUserId })}` };
}
async function cookieFor(meetingId) {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
  );
  return cookie;
}
async function openPanel(meetingId, who) {
  const cookie = await cookieFor(meetingId);
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, { cookie: [cookie, who?.session].filter(Boolean).join('; ') });
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId } }));
  await h.wait(100);
  return ws;
}
/** A pause or resume report as the panel of `who` sends it. */
async function report(meetingId, who, value, { cookieMeeting = meetingId, extra = {} } = {}) {
  const cookie = [who?.session, cookieMeeting && await cookieFor(cookieMeeting)].filter(Boolean).join('; ');
  return h.postJson(`${srv.base}/api/rtms/status`, { meetingId, status: value, ...extra }, cookie ? { cookie } : {});
}
const ofType = (ws, type) => ws.messages.filter((m) => m.type === type).map((m) => m.data);
const told = (ws) => ofType(ws, 'meeting.status').map((d) => d.status);
const state = (ws) => ofType(ws, 'arlo.state').at(-1);
async function stored(meetingId, path) {
  const res = await fetch(`${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/${path}`, { headers: { cookie: await cookieFor(meetingId) } });
  return res.json();
}
const texts = async (meetingId) => (await stored(meetingId, 'transcript')).segments.map((s) => s.text);
const timeline = async (meetingId) => (await stored(meetingId, 'participant-events')).events.map((e) => e.eventType);
/** Run `fn` with the server's clock moved ahead (the tests share the process with it). */
async function later(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

const ana = () => person('zoom-pause-ana', 'Ana Ruiz');
const ben = () => person('zoom-pause-ben', 'Ben Okafor');
const cy = () => person('zoom-pause-cy', 'Cy Lund'); // signed in to Arlo, never runs a stream

// --- pause is per stream ------------------------------------------------------

test('one stream: its owner pausing and resuming it pauses and resumes the meeting', async () => {
  const meeting = 'PAUSE-1==';
  const owner = await openPanel(meeting, ana());
  const guest = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });

  const paused = await report(meeting, ana(), 'rtms_paused');
  await h.wait(100);
  assert.equal(paused.status, 200);
  assert.deepEqual(told(guest), ['rtms_started', 'rtms_paused']);
  assert.deepEqual([state(owner).paused, state(owner).myStreamPaused], [true, true]);
  assert.equal(state(guest).paused, true);
  assert.equal('myStreamPaused' in state(guest), false);
  // said again, nothing is told again
  await report(meeting, ana(), 'rtms_paused');

  assert.equal((await report(meeting, ana(), 'rtms_resumed')).status, 200);
  await h.wait(100);
  for (const ws of [owner, guest]) ws.socket.close();
  assert.deepEqual(told(guest), ['rtms_started', 'rtms_paused', 'rtms_resumed']);
  assert.deepEqual([state(owner).paused, state(owner).myStreamPaused], [false, false]);
  assert.deepEqual(
    ofType(guest, 'participant.event').map((d) => d.event.eventType),
    ['transcription_started', 'transcription_paused', 'transcription_resumed'],
  );
  // a panel that opens while paused is told so
  await report(meeting, ana(), 'rtms_paused');
  const lateComer = await openPanel(meeting, null);
  lateComer.socket.close();
  assert.deepEqual(told(lateComer), ['rtms_paused']);
});

test('two streams: one owner pausing does not pause the meeting; both pausing does; one resuming resumes it', async () => {
  const meeting = 'PAUSE-2==';
  const anaPanel = await openPanel(meeting, ana());
  const benPanel = await openPanel(meeting, ben());
  const guest = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: ben().zoomUserId });

  await report(meeting, ana(), 'rtms_paused');
  await h.wait(100);
  assert.deepEqual(told(guest), ['rtms_started']);
  assert.deepEqual([state(anaPanel).paused, state(anaPanel).myStreamPaused], [false, true]);
  assert.deepEqual([state(benPanel).paused, state(benPanel).myStreamPaused], [false, false]);
  assert.equal(state(guest).paused, false);
  // the other stream's lines are still stored and shown
  await say(meeting, 's2', 'said while one stream is paused');

  await report(meeting, ben(), 'rtms_paused');
  await h.wait(100);
  assert.deepEqual(told(guest), ['rtms_started', 'rtms_paused']);
  assert.deepEqual([state(anaPanel).paused, state(anaPanel).myStreamPaused], [true, true]);
  assert.deepEqual([state(benPanel).paused, state(benPanel).myStreamPaused], [true, true]);

  await report(meeting, ana(), 'rtms_resumed');
  await h.wait(100);
  for (const ws of [anaPanel, benPanel, guest]) ws.socket.close();
  assert.deepEqual(told(guest), ['rtms_started', 'rtms_paused', 'rtms_resumed']);
  assert.deepEqual([state(anaPanel).paused, state(anaPanel).myStreamPaused], [false, false]);
  assert.deepEqual([state(benPanel).paused, state(benPanel).myStreamPaused], [false, true]);
  assert.deepEqual(await texts(meeting), ['said while one stream is paused']);
});

test('a paused stream that stops does not leave the meeting paused', async () => {
  const meeting = 'PAUSE-3==';
  const anaPanel = await openPanel(meeting, ana());
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: ben().zoomUserId });
  await report(meeting, ana(), 'rtms_paused');
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await h.wait(100);
  assert.deepEqual(told(anaPanel), ['rtms_started']);
  assert.deepEqual([state(anaPanel).present, state(anaPanel).paused, state(anaPanel).myStreamPaused], [true, false, false]);

  // both paused, then one of them stops: the other is still paused, and so is the meeting
  await status(meeting, { status: 'rtms_started', streamId: 's3', operatorId: ana().zoomUserId });
  await report(meeting, ana(), 'rtms_paused');
  await report(meeting, ben(), 'rtms_paused');
  await status(meeting, { status: 'rtms_stopped', streamId: 's3' });
  await h.wait(100);
  assert.deepEqual(told(anaPanel), ['rtms_started', 'rtms_paused']);
  assert.equal(state(anaPanel).paused, true);

  // the last one stops: the meeting is stopped, not paused, and a new start is running
  await status(meeting, { status: 'rtms_stopped', streamId: 's2' });
  await status(meeting, { status: 'rtms_started', streamId: 's4', operatorId: ben().zoomUserId });
  await h.wait(100);
  anaPanel.socket.close();
  assert.deepEqual(told(anaPanel), ['rtms_started', 'rtms_paused', 'rtms_stopped', 'rtms_started']);
  assert.equal(state(anaPanel).paused, false);
});

test('when the running stream stops and only a paused one is left, the meeting is paused; a new stream resumes it', async () => {
  const meeting = 'PAUSE-4==';
  const guest = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: ben().zoomUserId });
  await report(meeting, ana(), 'rtms_paused');
  await status(meeting, { status: 'rtms_stopped', streamId: 's2' });
  await h.wait(100);
  assert.deepEqual(told(guest), ['rtms_started', 'rtms_paused']);

  await status(meeting, { status: 'rtms_started', streamId: 's3', operatorId: ben().zoomUserId });
  await h.wait(100);
  guest.socket.close();
  assert.deepEqual(told(guest), ['rtms_started', 'rtms_paused', 'rtms_resumed']);
  assert.equal(state(guest).paused, false);
  // these changes came from the rtms service's reports: they are in the stored timeline
  assert.deepEqual(await timeline(meeting), ['transcription_started', 'transcription_paused', 'transcription_resumed']);
});

test('a line from a paused stream shows it is running: the pause is cleared', async () => {
  const meeting = 'PAUSE-5==';
  const owner = await openPanel(meeting, ana());
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await report(meeting, ana(), 'rtms_paused');
  // a line said before the pause, still on its way: stored, and the pause stands
  await say(meeting, 's1', 'on its way');
  await h.wait(100);
  assert.deepEqual(told(owner), ['rtms_started', 'rtms_paused']);
  assert.equal(state(owner).myStreamPaused, true);

  await later(4000, () => say(meeting, 's1', 'after the pause'));
  await h.wait(100);
  owner.socket.close();
  assert.deepEqual(told(owner), ['rtms_started', 'rtms_paused', 'rtms_resumed']);
  assert.deepEqual([state(owner).paused, state(owner).myStreamPaused], [false, false]);
  assert.deepEqual(await texts(meeting), ['on its way', 'after the pause']);
});

test('with two streams, a line from the paused one clears its owner\'s pause though the meeting was never paused', async () => {
  const meeting = 'PAUSE-6==';
  const owner = await openPanel(meeting, ana());
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: ben().zoomUserId });
  await report(meeting, ana(), 'rtms_paused');
  await h.wait(50);
  assert.equal(state(owner).myStreamPaused, true);
  await later(4000, () => say(meeting, 's1', 'running after all'));
  await h.wait(100);
  owner.socket.close();
  assert.deepEqual(told(owner), ['rtms_started']);
  assert.equal(state(owner).myStreamPaused, false);
});

test('only someone with a running stream of their own in the meeting may report pause or resume', async () => {
  const meeting = 'PAUSE-7==';
  const guest = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: ben().zoomUserId });

  for (const value of ['rtms_paused', 'rtms_resumed']) {
    assert.equal((await report(meeting, null, value)).status, 401, `${value} not signed in`);
    assert.equal((await report(meeting, cy(), value)).status, 403, `${value} signed in, in the meeting, no stream`);
    // naming someone else's stream does not make it theirs
    assert.equal((await report(meeting, cy(), value, { extra: { streamId: 's1', operatorId: ana().zoomUserId } })).status, 403);
  }
  // an owner whose stream stopped has nothing to pause
  await status(meeting, { status: 'rtms_stopped', streamId: 's2' });
  assert.equal((await report(meeting, ben(), 'rtms_paused')).status, 403);
  await h.wait(100);
  assert.deepEqual(told(guest), ['rtms_started']);
  assert.deepEqual(getMeetingStreams().pauseState(meeting), { meeting: false, streams: 0, operators: [] });

  // a report marks the caller's own stream, whatever stream it names
  await status(meeting, { status: 'rtms_started', streamId: 's3', operatorId: ben().zoomUserId });
  const own = await report(meeting, ben(), 'rtms_paused', { extra: { streamId: 's1', operatorId: ana().zoomUserId, replaced: true, meetingEnded: true } });
  await h.wait(100);
  guest.socket.close();
  assert.equal(own.status, 200);
  assert.deepEqual(getMeetingStreams().pauseState(meeting).operators, [ben().zoomUserId]);
  assert.deepEqual(told(guest), ['rtms_started']);
});

test('an owner cannot report pause with another meeting\'s access cookie, or with none', async () => {
  const meeting = 'PAUSE-8==';
  const guest = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await status('PAUSE-8-OTHER==', { status: 'rtms_started', streamId: 's9', operatorId: ana().zoomUserId });

  for (const value of ['rtms_paused', 'rtms_resumed']) {
    assert.equal((await report(meeting, ana(), value, { cookieMeeting: 'PAUSE-8-OTHER==' })).status, 403);
    assert.equal((await report(meeting, ana(), value, { cookieMeeting: null })).status, 403);
  }
  await h.wait(100);
  guest.socket.close();
  assert.deepEqual(told(guest), ['rtms_started']);
  assert.equal(getMeetingStreams().pauseState(meeting).streams, 0);
});

test('the rtms service\'s own pause report names the stream', async () => {
  const meeting = 'PAUSE-9==';
  const guest = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await status(meeting, { status: 'rtms_paused', streamId: 's2' });
  await h.wait(50);
  assert.deepEqual(told(guest), ['rtms_started']);
  await status(meeting, { status: 'rtms_paused', streamId: 's1' });
  await status(meeting, { status: 'rtms_resumed', streamId: 's2' });
  await h.wait(100);
  guest.socket.close();
  assert.deepEqual(told(guest), ['rtms_started', 'rtms_paused', 'rtms_resumed']);
});

// --- a stream its user replaced with a new one --------------------------------

/** Take the 90-second timers out of the real clock while `fn` runs; returns them. */
async function catchingWait(fn) {
  const realSetTimeout = global.setTimeout;
  const caught = [];
  global.setTimeout = (callback, ms, ...args) => {
    if (ms !== 90_000) return realSetTimeout(callback, ms, ...args);
    caught.push(callback);
    return { unref() {} };
  };
  try {
    await fn();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  return caught;
}

test('`replaced` must be a boolean, and only the rtms service may say it', async () => {
  const meeting = 'REPLACE-0==';
  for (const bad of ['true', 1, 0, null, {}, []]) {
    assert.equal((await status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: bad })).status, 400);
  }
  assert.equal((await status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: false })).status, 200);
  const fromBrowser = await report(meeting, ana(), 'rtms_stopped', { extra: { streamId: 's1', replaced: true } });
  assert.equal(fromBrowser.status, 403);
});

test('the meeting\'s only stream is replaced and the new one starts: the panels never see a stop', async () => {
  const meeting = 'REPLACE-1==';
  const panel = await openPanel(meeting, ana());
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await say(meeting, 's1', 'before the restart');

  const stop = await status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: true });
  await h.wait(100);
  assert.deepEqual(stop.body, { received: true, broadcast: 0 });
  assert.deepEqual(told(panel), ['rtms_started']);
  assert.equal(state(panel).present, true);
  assert.equal(getMeetingStreams().anyLive(meeting), false);
  assert.equal(getMeetingStreams().awaitingReplacement(meeting), true);
  // the old stream's own stop from Zoom, arriving now, changes nothing
  const zoomStop = await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  assert.deepEqual(zoomStop.body, { received: true, broadcast: 0 });
  assert.equal(getMeetingStreams().awaitingReplacement(meeting), true);

  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: ana().zoomUserId });
  await say(meeting, 's2', 'after the restart');
  await h.wait(100);
  panel.socket.close();
  // the panel that asked gets its "started"; nobody was told "stopped"
  assert.deepEqual(told(panel), ['rtms_started', 'rtms_started']);
  assert.equal(state(panel).present, true);
  assert.equal(state(panel).role, 'owner');
  assert.equal(getMeetingStreams().awaitingReplacement(meeting), false);
  assert.deepEqual(await timeline(meeting), ['transcription_started']); // one line, not one per stream
  // the lifecycle was never told the meeting stopped: with no panel left, the data stays
  await h.wait(450);
  assert.deepEqual(await texts(meeting), ['before the restart', 'after the restart']);
});

test('the meeting\'s only stream is replaced and the new one cannot be joined: now the panels and the lifecycle are told', async () => {
  const meeting = 'REPLACE-2==';
  const panel = await openPanel(meeting, ana());
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await say(meeting, 's1', 'before the restart');
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: true });
  await h.wait(450); // longer than the grace period would be
  assert.deepEqual(told(panel), ['rtms_started']);

  await status(meeting, { status: 'rtms_failed', streamId: 's2' });
  await h.wait(100);
  panel.socket.close();
  assert.deepEqual(told(panel), ['rtms_started', 'rtms_failed']);
  assert.equal(state(panel).present, false);
  assert.equal(getMeetingStreams().awaitingReplacement(meeting), false);
  assert.deepEqual(await timeline(meeting), ['transcription_started', 'transcription_stopped']);
  // the lifecycle sees no stream running: with the last panel gone the data is flushed
  await h.wait(450);
  assert.deepEqual(await texts(meeting), []);
});

test('the meeting\'s only stream is replaced and the new one is stopped before it starts: the stop is told', async () => {
  const meeting = 'REPLACE-3==';
  const panel = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: true });
  await status(meeting, { status: 'rtms_stopped', streamId: 's2', fault: true });
  await h.wait(100);
  panel.socket.close();
  const statuses = ofType(panel, 'meeting.status');
  assert.deepEqual(statuses.map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.equal(statuses[1].fault, true);
  assert.equal(state(panel).present, false);
  assert.equal(getMeetingStreams().awaitingReplacement(meeting), false);
  assert.deepEqual(await timeline(meeting), ['transcription_started', 'transcription_stopped']);
});

test('the meeting\'s only stream is replaced and nothing is heard of the new one: the stop is told after 90 seconds', async () => {
  const meeting = 'REPLACE-4==';
  const panel = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await say(meeting, 's1', 'before the restart');
  const timers = await catchingWait(() => status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: true }));
  await h.wait(100);
  assert.equal(timers.length, 1);
  assert.deepEqual(told(panel), ['rtms_started']);

  timers[0]();
  await h.wait(100);
  panel.socket.close();
  assert.deepEqual(told(panel), ['rtms_started', 'rtms_stopped']);
  assert.equal('fault' in ofType(panel, 'meeting.status')[1], false);
  assert.equal(state(panel).present, false);
  assert.deepEqual(await timeline(meeting), ['transcription_started', 'transcription_stopped']);
  timers[0](); // and only once
  await h.wait(450);
  assert.deepEqual(await texts(meeting), []); // the lifecycle was told: flushed with no panel left
});

test('a wait that was settled by the new stream starting says nothing when its timer fires', async () => {
  const meeting = 'REPLACE-5==';
  const panel = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  const timers = await catchingWait(() => status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: true }));
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-1' });
  timers[0]();
  await h.wait(100);
  panel.socket.close();
  assert.deepEqual(told(panel), ['rtms_started', 'rtms_started']);
  assert.equal(state(panel).present, true);
});

test('a replaced stream while another user\'s stream runs is an ordinary quiet stop: nothing is waited for', async () => {
  const meeting = 'REPLACE-6==';
  const panel = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: true });
  assert.equal(getMeetingStreams().awaitingReplacement(meeting), false);
  await status(meeting, { status: 'rtms_failed', streamId: 's3' });
  await h.wait(100);
  panel.socket.close();
  assert.deepEqual(told(panel), ['rtms_started']);
  assert.equal(getMeetingStreams().anyLive(meeting), true);
});

test('the meeting ending while a replacement is waited for ends the wait with the meeting', async () => {
  const meeting = 'REPLACE-7==';
  const panel = await openPanel(meeting, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  const timers = await catchingWait(() => status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: true }));
  await status(meeting, { status: 'rtms_stopped', streamId: 's2', meetingEnded: true });
  assert.equal(getMeetingStreams().awaitingReplacement(meeting), false);
  assert.deepEqual(getMeetingStreams().operators(meeting), []);
  timers[0]();
  await h.wait(100);
  panel.socket.close();
  const statuses = ofType(panel, 'meeting.status');
  assert.deepEqual(statuses.map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.equal(statuses[1].meetingEnded, true);
});

test('a paused only stream that is replaced: the new stream is running, not paused', async () => {
  const meeting = 'REPLACE-8==';
  const panel = await openPanel(meeting, ana());
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana().zoomUserId });
  await report(meeting, ana(), 'rtms_paused');
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: true });
  await h.wait(50);
  assert.deepEqual(told(panel), ['rtms_started', 'rtms_paused']); // nothing shown while waiting
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: ana().zoomUserId });
  await h.wait(100);
  panel.socket.close();
  assert.deepEqual(told(panel), ['rtms_started', 'rtms_paused', 'rtms_resumed', 'rtms_started']);
  assert.deepEqual([state(panel).paused, state(panel).myStreamPaused], [false, false]);
});
