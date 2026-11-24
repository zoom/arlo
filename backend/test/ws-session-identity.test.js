// Who a socket is: a signed-in user only through a valid session. The
// meeting-access cookie proves the meeting and nothing else, also when it was
// issued to a signed-in user. After logout, after the app was removed, and
// after a session ran out, a socket is a guest's.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const test = require('node:test');
const assert = require('node:assert/strict');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { getArloPresence } = require('../src/services/arloPresence');
const sockets = require('../src/services/websocket');
const deauthorized = require('../src/lib/deauthorized');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const internal = { 'x-arlo-internal-key': h.internalKey() };
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
const say = (meetingId, text) => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, streamId: 's1', segment: { seqNo: 1, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: 1000, tEndMs: 1000 } },
  internal,
);

let people = 0;
function person(displayName, { expiresInMs } = {}) {
  people += 1;
  const zoomUserId = `zoom-ws-identity-${people}`;
  const user = userStore.upsert(zoomUserId, { email: `${zoomUserId}@example.test`, displayName, avatarUrl: null });
  const token = generateToken({ userId: user.id, zoomUserId, ...(expiresInMs && { exp: Date.now() + expiresInMs }) });
  return { user, zoomUserId, session: `sessionToken=${token}` };
}
const cookies = (...parts) => ({ cookie: parts.filter(Boolean).join('; ') });
/** A meeting-access cookie; with `session`, one issued to that signed-in user (their user id is in it). */
async function access(meetingId, session) {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
    session ? { cookie: session } : {},
  );
  return cookie;
}
const url = (meetingId, path) => `${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/arlo/${path}`;
const post = (meetingId, path, headers, body) => h.postJson(url(meetingId, path), body, headers);
const put = async (meetingId, path, headers, body) => (await fetch(url(meetingId, path), {
  method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})).status;

const panel = async (meetingId, headers) => {
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, headers);
  assert.equal(ws.open, true);
  return ws;
};
const ofType = (ws, type) => ws.messages.filter((msg) => msg.type === type).map((msg) => msg.data);
const lastRole = (ws) => ofType(ws, 'arlo.state').pop()?.role;
const NOTES = { summary: 'They ship Friday.', decisions: [], actionItems: [], updatedAt: 1, throughSeqNo: 1 };
const sendNotes = (meetingId) => sockets.sendNotesUpdated(meetingId, getArloPresence().ownerUserIds(meetingId), NOTES);

/** A meeting Ana brought Arlo into (her meeting-access cookie carries her user id); Ben is signed in. */
async function meetingWith(meetingId, anaOptions) {
  const ana = person('Ana Ruiz', anaOptions);
  const ben = person('Ben Okafor');
  const anaPass = await access(meetingId, ana.session);
  const guestPass = await access(meetingId);
  await status(meetingId, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  await say(meetingId, 'We ship on Friday.');
  return {
    meetingId, ana, ben, anaPass, guestPass,
    owner: cookies(anaPass, ana.session),
    participant: cookies(guestPass, ben.session),
  };
}

test('a signed-in owner is an owner on their socket and gets what owners get', async () => {
  const m = await meetingWith('WSI-OWNER==');
  const ws = await panel(m.meetingId, m.owner);
  await h.wait(30);
  assert.equal(lastRole(ws), 'owner');
  assert.equal(ofType(ws, 'connected')[0].isGuest, false);
  sendNotes(m.meetingId);
  assert.equal((await post(m.meetingId, 'notes-request', m.participant, {})).status, 200);
  await h.wait(50);
  assert.equal(ofType(ws, 'notes.updated').length, 1);
  assert.equal(ofType(ws, 'arlo.approval').length, 1);
  assert.equal(ofType(ws, 'arlo.approval')[0].askedBy, 'Ben Okafor');
  ws.socket.close();
});

test('a socket with only the owner\'s meeting-access cookie is a guest: no owner role, no private notes, no approvals', async () => {
  const m = await meetingWith('WSI-ACCESS-ONLY==');
  const ws = await panel(m.meetingId, cookies(m.anaPass));
  await h.wait(30);
  assert.equal(ofType(ws, 'connected')[0].isGuest, true);
  assert.equal(ofType(ws, 'connected')[0].userId, null);
  assert.equal(lastRole(ws), 'participant');
  sendNotes(m.meetingId);
  assert.equal((await post(m.meetingId, 'notes-request', m.participant, {})).status, 200);
  await h.wait(50);
  assert.deepEqual(ofType(ws, 'notes.updated'), []);
  assert.deepEqual(ofType(ws, 'arlo.approval'), []);
  // it cannot announce hands either
  ws.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'host', can: ['post_to_chat'] } }));
  await h.wait(30);
  assert.deepEqual(sockets.handsPanels(m.meetingId), []);
  // a forged or expired session next to it changes nothing
  const forged = await panel(m.meetingId, cookies(m.anaPass, 'sessionToken=forged.token.value'));
  await h.wait(30);
  assert.equal(lastRole(forged), 'participant');
  ws.socket.close();
  forged.socket.close();
});

test('a guest socket still gets the meeting\'s public messages, and the notes while they are shared', async () => {
  const m = await meetingWith('WSI-GUEST==');
  const guest = await panel(m.meetingId, cookies(m.anaPass));
  await h.wait(30);
  await say(m.meetingId, 'A second line.');
  await h.wait(30);
  assert.equal(ofType(guest, 'transcript.segment').length, 1);
  assert.equal(await put(m.meetingId, 'settings', m.owner, { shareNotes: true }), 200);
  sendNotes(m.meetingId);
  await h.wait(50);
  assert.ok(ofType(guest, 'notes.updated').length >= 1);
  assert.equal(ofType(guest, 'arlo.state').pop().notesShared, true);
  assert.equal(lastRole(guest), 'participant');
  guest.socket.close();
});

test('logout closes the user\'s sockets, clears the meeting-access cookie, and a reconnect is a guest', async () => {
  const m = await meetingWith('WSI-LOGOUT==');
  const ws = await panel(m.meetingId, m.owner);
  const other = await panel(m.meetingId, m.participant);
  await h.wait(30);
  assert.equal(lastRole(ws), 'owner');
  const closed = new Promise((resolve) => ws.socket.on('close', resolve));

  const res = await fetch(`${srv.base}/api/auth/logout`, { method: 'POST', headers: m.owner });
  assert.equal(res.status, 200);
  const cleared = res.headers.getSetCookie();
  for (const name of ['sessionToken', 'sessionRestore', 'meetingAccess']) {
    const line = cleared.find((cookie) => cookie.startsWith(`${name}=;`));
    assert.ok(line, `${name} is cleared`);
    assert.match(line, /Expires=Thu, 01 Jan 1970/);
    assert.match(line, /HttpOnly/);
    assert.match(line, /SameSite=Lax/);
    assert.match(line, /Path=\//);
  }
  const code = await Promise.race([closed, h.wait(1500).then(() => 'still open')]);
  assert.equal(code, 4001);
  // someone else's socket is left alone
  assert.equal(other.socket.readyState, 1);

  // the browser kept only what a script could not clear: nothing. Even with
  // the old meeting-access cookie replayed, the new socket is a guest's
  const again = await panel(m.meetingId, cookies(m.anaPass));
  await h.wait(30);
  assert.equal(lastRole(again), 'participant');
  sendNotes(m.meetingId);
  // Ben's panel is open, so the approval has somewhere to go if it leaked
  assert.equal((await post(m.meetingId, 'notes-request', m.participant, {})).status, 200);
  await h.wait(50);
  assert.deepEqual(ofType(again, 'notes.updated'), []);
  assert.deepEqual(ofType(again, 'arlo.approval'), []);
  // and without any cookie there is no socket at all
  assert.equal((await h.wsRejection(`${srv.wsBase}?meeting_id=x`)).code, 1008);
  again.socket.close();
  other.socket.close();
});

test('after the app was removed, the closed socket\'s reconnect with the same cookies is a guest', async () => {
  const m = await meetingWith('WSI-DEAUTH==');
  const ws = await panel(m.meetingId, m.owner);
  await h.wait(30);
  const closed = new Promise((resolve) => ws.socket.on('close', resolve));
  await h.postWebhook(srv.base, {
    event: 'app_deauthorized',
    payload: { account_id: 'a', user_id: m.ana.zoomUserId, client_id: 'test-client-id', signature: 's', deauthorization_time: new Date().toISOString() },
  });
  assert.equal(await Promise.race([closed, h.wait(1500).then(() => 'still open')]), 4001);
  const again = await panel(m.meetingId, m.owner);
  await h.wait(30);
  assert.equal(ofType(again, 'connected')[0].isGuest, true);
  assert.equal(lastRole(again), 'participant');
  again.socket.close();
  deauthorized.clear(m.ana.zoomUserId);
});

test('a session that runs out while the socket is open: the socket stops being that user', async () => {
  const m = await meetingWith('WSI-EXPIRE==', { expiresInMs: 400 });
  const ws = await panel(m.meetingId, m.owner);
  ws.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'host', can: ['post_to_chat'] } }));
  await h.wait(30);
  assert.equal(lastRole(ws), 'owner');
  assert.equal(sockets.handsPanels(m.meetingId).length, 1);
  sendNotes(m.meetingId);
  await h.wait(30);
  assert.equal(ofType(ws, 'notes.updated').length, 1);

  await h.wait(450); // the session is over; the socket is still open
  assert.equal(ws.socket.readyState, 1);
  sendNotes(m.meetingId);
  assert.equal((await post(m.meetingId, 'notes-request', m.participant, {})).status, 200);
  assert.deepEqual(sockets.handsPanels(m.meetingId), []);
  assert.equal(sockets.crossRegisterUser(m.ana.user.id, 'WSI-EXPIRE-RTMS=='), 0);
  await h.wait(50);
  assert.equal(ofType(ws, 'notes.updated').length, 1, 'no notes after the session ended');
  assert.deepEqual(ofType(ws, 'arlo.approval'), []);
  // it was told what it is now
  assert.equal(lastRole(ws), 'participant');
  // public messages still arrive
  await say(m.meetingId, 'Another line.');
  await h.wait(30);
  assert.ok(ofType(ws, 'transcript.segment').length >= 1);
  ws.socket.close();
});

test('a user removed from the app while their socket is open is not that user for a send that races the close', async () => {
  const m = await meetingWith('WSI-DEAUTH-RACE==');
  const ws = await panel(m.meetingId, m.owner);
  await h.wait(30);
  // What the webhook does first; the socket is not closed yet
  deauthorized.mark(m.ana.zoomUserId);
  sendNotes(m.meetingId);
  await h.wait(50);
  assert.deepEqual(ofType(ws, 'notes.updated'), []);
  assert.equal(lastRole(ws), 'participant');
  ws.socket.close();
  deauthorized.clear(m.ana.zoomUserId);
});
