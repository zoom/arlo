// An owner shares the live notes with everyone in the meeting who has Arlo
// open: the setting, who then gets the notes (socket and GET), the notes
// engine's reader rule, the approval that turns sharing on, and the flush.
// The model call is replaced: nothing leaves the machine.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const test = require('node:test');
const assert = require('node:assert/strict');
const openrouter = require('../src/services/openrouter');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { getNotesEngine } = require('../src/services/notesEngine');
const { getMeetingStore } = require('../src/storage');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');

let srv;
const realNotes = openrouter.generateLiveNotes;
let modelCalls = 0;
test.before(async () => {
  openrouter.generateLiveNotes = async (input) => {
    modelCalls += 1;
    return { summary: `They ship Friday (${input.lines.length}).`, decisions: ['Ship Friday'], actionItems: [] };
  };
  srv = await h.startServer();
});
test.after(() => {
  openrouter.generateLiveNotes = realNotes;
  srv.server.closeAllConnections?.();
  srv.server.close();
});

const internal = { 'x-arlo-internal-key': h.internalKey() };
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
const say = (meetingId, text) => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, streamId: 's1', segment: { seqNo: 1, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: 1000, tEndMs: 1000 } },
  internal,
);
const sayMany = async (meetingId, count, word = 'line') => {
  for (let i = 1; i <= count; i += 1) await say(meetingId, `${word} ${i}`);
};

let people = 0;
function person(displayName) {
  people += 1;
  const zoomUserId = `zoom-share-notes-${people}`;
  const user = userStore.upsert(zoomUserId, { email: `${zoomUserId}@example.test`, displayName, avatarUrl: null });
  return { user, zoomUserId, session: `sessionToken=${generateToken({ userId: user.id, zoomUserId })}` };
}
async function access(meetingId) {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
  );
  return cookie;
}
const cookies = (...parts) => ({ cookie: parts.filter(Boolean).join('; ') });
const url = (meetingId, path) => `${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/arlo/${path}`;

async function call(method, meetingId, path, { headers = {}, body } = {}) {
  const res = await fetch(url(meetingId, path), {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, cache: res.headers.get('cache-control') };
}

/** A meeting Ana brought Arlo into; Ben and Dee are signed-in participants. */
async function meetingWith(meetingId) {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  const dee = person('Dee Marsh');
  const pass = await access(meetingId);
  await status(meetingId, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  return {
    meetingId, ana, ben, dee, pass,
    owner: cookies(pass, ana.session),
    participant: cookies(pass, ben.session),
    third: cookies(pass, dee.session),
    guest: cookies(pass),
  };
}

const panel = async (meetingId, headers) => {
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, headers);
  assert.equal(ws.open, true);
  return ws;
};
const notesSent = (ws) => ws.messages.filter((msg) => msg.type === 'notes.updated').map((msg) => msg.data);
const states = (ws) => ws.messages.filter((msg) => msg.type === 'arlo.state').map((msg) => msg.data);
const lastState = (ws) => states(ws)[states(ws).length - 1];
const closeAll = (...panels) => panels.forEach((ws) => ws.socket.close());
const share = (m, value, headers = m.owner) => call('PUT', m.meetingId, 'settings', { headers, body: { shareNotes: value } });
const getNotes = (m, headers) => call('GET', m.meetingId, 'notes', { headers });

test('the store keeps notesShared as a boolean only, false by default, and it goes with the meeting', () => {
  const store = createMemoryMeetingStore();
  assert.equal(store.getMeta('M1').notesShared, false);
  store.appendSegment('M1', { text: 'Hello.' });
  assert.equal(store.getMeta('M1').notesShared, false);
  for (const bad of ['true', 1, null, undefined, {}, [], 'yes']) {
    assert.equal(store.setMeta('M1', { notesShared: bad }).notesShared, false, JSON.stringify(bad));
  }
  assert.equal(store.setMeta('M1', { notesShared: true }).notesShared, true);
  for (const bad of ['false', 0, null, '']) {
    assert.equal(store.setMeta('M1', { notesShared: bad }).notesShared, true, JSON.stringify(bad));
  }
  // another field leaves it alone
  assert.equal(store.setMeta('M1', { whoCanAsk: 'anyone' }).notesShared, true);
  assert.equal(store.setMeta('M1', { notesShared: false }).notesShared, false);
  store.setMeta('M1', { notesShared: true });
  store.deleteMeeting('M1');
  assert.equal(store.getMeta('M1').notesShared, false);
  assert.equal(store.setMeta('M1', { notesShared: true }), null);
});

test('shareNotes is a boolean and only an owner changes it', async () => {
  const m = await meetingWith('SN-SETTING==');
  await say(m.meetingId, 'Hello.');
  assert.equal((await share(m, true, m.participant)).status, 403);
  assert.equal((await share(m, true, m.guest)).status, 401);
  const otherPass = await access('SN-SETTING-OTHER==');
  assert.equal((await share(m, true, cookies(otherPass, m.ana.session))).status, 403);

  const bad = [
    { shareNotes: 'true' }, { shareNotes: 1 }, { shareNotes: 0 }, { shareNotes: null }, { shareNotes: {} }, { shareNotes: [true] },
    { shareNotes: 'on' }, { shareNotes: true, notesShared: true }, { shareNotes: true, extra: 1 }, { notesShared: true },
    { shareNotes: true, whoCanAsk: 'everyone' }, { whoCanAsk: 'anyone', shareNotes: 'yes' }, {},
  ];
  for (const body of bad) {
    const res = await call('PUT', m.meetingId, 'settings', { headers: m.owner, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  // nothing was changed by a refused request, also not its valid half
  assert.equal(getMeetingStore().getMeta(m.meetingId).notesShared, false);
  assert.equal(getMeetingStore().getMeta(m.meetingId).whoCanAsk, 'owner');

  const on = await share(m, true);
  assert.equal(on.status, 200);
  assert.equal(on.cache, 'no-store');
  assert.equal(on.body.notesShared, true);
  assert.equal(on.body.role, 'owner');
  // together with another field
  const both = await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { shareNotes: false, whoCanAsk: 'anyone' } });
  assert.equal(both.status, 200);
  assert.equal(both.body.notesShared, false);
  assert.equal(both.body.whoCanAsk, 'anyone');
});

test('the state carries notesShared for everyone, over GET and over the socket', async () => {
  const m = await meetingWith('SN-STATE==');
  await say(m.meetingId, 'Hello.');
  const [ownerPanel, benPanel, guestPanel] = await Promise.all([
    panel(m.meetingId, m.owner), panel(m.meetingId, m.participant), panel(m.meetingId, m.guest),
  ]);
  await h.wait(50);
  for (const ws of [ownerPanel, benPanel, guestPanel]) assert.equal(lastState(ws).notesShared, false);
  for (const headers of [m.owner, m.participant, m.guest]) {
    assert.equal((await call('GET', m.meetingId, 'state', { headers })).body.notesShared, false);
  }

  await share(m, true);
  await h.wait(100);
  for (const ws of [ownerPanel, benPanel, guestPanel]) {
    assert.equal(lastState(ws).notesShared, true);
    assert.equal(lastState(ws).meetingId, m.meetingId);
  }
  assert.equal(lastState(benPanel).role, 'participant');
  for (const headers of [m.owner, m.participant, m.guest]) {
    assert.equal((await call('GET', m.meetingId, 'state', { headers })).body.notesShared, true);
  }
  // the same value again changes nothing and tells nobody
  const told = states(benPanel).length;
  assert.equal((await share(m, true)).status, 200);
  await h.wait(100);
  assert.equal(states(benPanel).length, told);

  await share(m, false);
  await h.wait(100);
  for (const ws of [ownerPanel, benPanel, guestPanel]) assert.equal(lastState(ws).notesShared, false);
  closeAll(ownerPanel, benPanel, guestPanel);
});

test('who gets the notes: owners always, everyone verified for the meeting while shared, nobody from another meeting', async () => {
  const m = await meetingWith('SN-MATRIX==');
  const other = 'SN-MATRIX-OTHER==';
  const otherPass = await access(other);
  const [ownerPanel, benPanel, guestPanel, benElsewhere, guestElsewhere] = await Promise.all([
    panel(m.meetingId, m.owner), panel(m.meetingId, m.participant), panel(m.meetingId, m.guest),
    panel(other, cookies(otherPass, m.ben.session)), panel(other, cookies(otherPass)),
  ]);
  // what a stream start does: a person's sockets are all listed under the stream's meeting
  const { crossRegisterUser } = require('../src/services/websocket');
  crossRegisterUser(m.ben.user.id, m.meetingId);
  await h.wait(50);

  // not shared
  await sayMany(m.meetingId, 5);
  await h.wait(150);
  assert.equal(notesSent(ownerPanel).length, 1);
  for (const ws of [benPanel, guestPanel, benElsewhere, guestElsewhere]) assert.deepEqual(notesSent(ws), []);
  assert.equal((await getNotes(m, m.owner)).status, 200);
  for (const headers of [m.participant, m.guest]) {
    const res = await getNotes(m, headers);
    assert.equal(res.status, 403);
    assert.equal(res.cache, 'no-store');
    assert.equal(JSON.stringify(res.body).includes('Friday'), false);
  }
  assert.equal((await getNotes(m, cookies(otherPass, m.ben.session))).status, 403);
  assert.equal((await getNotes(m, cookies(otherPass))).status, 403);
  assert.equal((await getNotes(m, cookies(m.ben.session))).status, 401);
  assert.equal((await getNotes(m, {})).status, 401);

  // turned on: the current notes go out at once
  await share(m, true);
  await h.wait(100);
  const current = getMeetingStore().getNotes(m.meetingId);
  for (const ws of [benPanel, guestPanel]) {
    assert.deepEqual(notesSent(ws), [{ meetingId: m.meetingId, notes: current }]);
    // told that they are shared before the notes arrive
    const types = ws.messages.map((msg) => msg.type);
    const stateAt = ws.messages.findIndex((msg) => msg.type === 'arlo.state' && msg.data.notesShared === true);
    assert.ok(stateAt !== -1 && stateAt < types.indexOf('notes.updated'));
  }
  for (const ws of [benElsewhere, guestElsewhere]) assert.deepEqual(notesSent(ws), []);
  for (const headers of [m.owner, m.participant, m.third, m.guest]) {
    const res = await getNotes(m, headers);
    assert.equal(res.status, 200);
    assert.equal(res.cache, 'no-store');
    assert.deepEqual(res.body, { notes: current });
  }
  // still: another meeting's access is not this meeting's, signed in or not
  assert.equal((await getNotes(m, cookies(otherPass, m.ben.session))).status, 403);
  assert.equal((await getNotes(m, cookies(otherPass))).status, 403);
  assert.equal((await getNotes(m, cookies(m.ben.session))).status, 401);
  // a session that does not verify is a guest with meeting access, not an error
  assert.equal((await getNotes(m, cookies(m.pass, 'sessionToken=forged.token.value'))).status, 200);

  // the next notes go to everyone here
  await sayMany(m.meetingId, 2, 'more');
  assert.equal(await getNotesEngine().runNow(m.meetingId), true);
  await h.wait(100);
  assert.equal(notesSent(benPanel).length, 2);
  assert.equal(notesSent(guestPanel).length, 2);
  for (const ws of [benElsewhere, guestElsewhere]) assert.deepEqual(notesSent(ws), []);

  // turned off: delivery stops at once
  await share(m, false);
  await sayMany(m.meetingId, 2, 'later');
  assert.equal(await getNotesEngine().runNow(m.meetingId), true);
  await h.wait(100);
  assert.equal(notesSent(benPanel).length, 2);
  assert.equal(notesSent(guestPanel).length, 2);
  assert.ok(notesSent(ownerPanel).length >= 3);
  assert.equal(lastState(benPanel).notesShared, false);
  assert.equal(lastState(guestPanel).notesShared, false);
  for (const headers of [m.participant, m.third, m.guest]) assert.equal((await getNotes(m, headers)).status, 403);
  assert.equal((await getNotes(m, m.owner)).status, 200);
  closeAll(ownerPanel, benPanel, guestPanel, benElsewhere, guestElsewhere);
});

test('turning sharing on with no notes yet sends none', async () => {
  const m = await meetingWith('SN-EMPTY==');
  await say(m.meetingId, 'Hello.');
  const benPanel = await panel(m.meetingId, m.participant);
  await share(m, true);
  await h.wait(100);
  assert.deepEqual(notesSent(benPanel), []);
  assert.deepEqual((await getNotes(m, m.participant)).body, { notes: null });
  closeAll(benPanel);
});

test('the engine writes notes for a participant\'s or a guest\'s panel only while the notes are shared', async () => {
  for (const [meetingId, who] of [['SN-ENGINE-1==', 'participant'], ['SN-ENGINE-2==', 'guest']]) {
    const m = await meetingWith(meetingId);
    const reader = await panel(m.meetingId, m[who]); // the owner has no panel open
    const before = modelCalls;
    await sayMany(m.meetingId, 6);
    await h.wait(150);
    assert.equal(modelCalls, before, `${who}: nothing is written while not shared`);
    assert.equal(getMeetingStore().getNotes(m.meetingId), null);
    assert.equal(await getNotesEngine().runNow(m.meetingId), false);

    // shared: the waiting lines are written up for the panel that is here
    assert.equal((await share(m, true)).status, 200);
    await h.wait(150);
    assert.equal(modelCalls, before + 1, `${who}: written once shared`);
    assert.equal(notesSent(reader).length, 1);

    // not shared any more: nothing is written for that panel
    await share(m, false);
    await sayMany(m.meetingId, 2, 'more');
    assert.equal(await getNotesEngine().runNow(m.meetingId), false);
    assert.equal(modelCalls, before + 1);
    closeAll(reader);
  }
});

test('when shared, a participant\'s panel that connects starts the notes that were waiting', async () => {
  const m = await meetingWith('SN-ENGINE-LATE==');
  await say(m.meetingId, 'Hello.');
  await share(m, true);
  const before = modelCalls;
  await sayMany(m.meetingId, 6);
  await h.wait(100);
  assert.equal(modelCalls, before); // nobody has a panel open
  const guestPanel = await panel(m.meetingId, m.guest);
  await h.wait(150);
  assert.equal(modelCalls, before + 1);
  assert.equal(notesSent(guestPanel).length, 1);
  closeAll(guestPanel);
});

test('an owner who approves a request turns sharing on: everyone is told and the notes go out', async () => {
  let n = 0;
  for (const body of [{ approve: true }, { approve: true, done: true }, { approve: true, done: false }]) {
    n += 1;
    const m = await meetingWith(`SN-APPROVE-${n}==`);
    const [ownerPanel, benPanel, deePanel, guestPanel] = await Promise.all([
      panel(m.meetingId, m.owner), panel(m.meetingId, m.participant), panel(m.meetingId, m.third), panel(m.meetingId, m.guest),
    ]);
    await sayMany(m.meetingId, 5);
    await h.wait(150);
    const { id } = (await call('POST', m.meetingId, 'notes-request', { headers: m.participant, body: {} })).body;
    const res = await call('POST', m.meetingId, `approvals/${id}`, { headers: m.owner, body });
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(res.body, { id, outcome: 'approved' });
    await h.wait(100);

    assert.equal(getMeetingStore().getMeta(m.meetingId).notesShared, true);
    const closed = { type: 'arlo.approval.closed', data: { meetingId: m.meetingId, id, outcome: 'approved' } };
    assert.deepEqual(benPanel.messages.filter((msg) => msg.type === 'arlo.approval.closed'), [closed]);
    assert.deepEqual(ownerPanel.messages.filter((msg) => msg.type === 'arlo.approval.closed'), [closed]);
    for (const ws of [ownerPanel, benPanel, deePanel, guestPanel]) assert.equal(lastState(ws).notesShared, true);
    for (const ws of [benPanel, deePanel, guestPanel]) {
      assert.deepEqual(notesSent(ws), [{ meetingId: m.meetingId, notes: getMeetingStore().getNotes(m.meetingId) }]);
    }
    closeAll(ownerPanel, benPanel, deePanel, guestPanel);
  }
});

test('a declined request shares nothing; the answer still takes booleans and known fields only', async () => {
  const m = await meetingWith('SN-DECLINE==');
  const benPanel = await panel(m.meetingId, m.participant);
  await say(m.meetingId, 'Hello.');
  const { id } = (await call('POST', m.meetingId, 'notes-request', { headers: m.participant, body: {} })).body;
  const bad = [
    {}, { approve: 'true' }, { approve: 1 }, { approve: null }, { done: true }, { approve: true, done: 'yes' }, { approve: true, done: null },
    { approve: true, shareNotes: true }, { approve: true, done: true, notesShared: true }, [true], 'yes',
  ];
  for (const body of bad) {
    assert.equal((await call('POST', m.meetingId, `approvals/${id}`, { headers: m.owner, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', m.meetingId, `approvals/${id}`, { headers: m.participant, body: { approve: true } })).status, 403);
  assert.equal(getMeetingStore().getMeta(m.meetingId).notesShared, false);

  // `done` is ignored: declining is declining
  const res = await call('POST', m.meetingId, `approvals/${id}`, { headers: m.owner, body: { approve: false, done: true } });
  assert.deepEqual(res.body, { id, outcome: 'declined' });
  await h.wait(100);
  assert.equal(getMeetingStore().getMeta(m.meetingId).notesShared, false);
  assert.equal(lastState(benPanel).notesShared, false);
  assert.deepEqual(notesSent(benPanel), []);
  closeAll(benPanel);
});

test('turning sharing on in the settings answers the requests that were open', async () => {
  const m = await meetingWith('SN-OPEN-REQUESTS==');
  const [ownerPanel, benPanel] = await Promise.all([panel(m.meetingId, m.owner), panel(m.meetingId, m.participant)]);
  await say(m.meetingId, 'Hello.');
  const { id } = (await call('POST', m.meetingId, 'notes-request', { headers: m.participant, body: {} })).body;
  await share(m, true);
  await h.wait(100);
  const closed = { type: 'arlo.approval.closed', data: { meetingId: m.meetingId, id, outcome: 'approved' } };
  assert.deepEqual(benPanel.messages.filter((msg) => msg.type === 'arlo.approval.closed'), [closed]);
  assert.deepEqual(ownerPanel.messages.filter((msg) => msg.type === 'arlo.approval.closed'), [closed]);
  assert.deepEqual((await call('GET', m.meetingId, 'approvals', { headers: m.owner })).body, { approvals: [] });
  closeAll(ownerPanel, benPanel);
});

test('asking for notes that are shared already is a 409 and opens nothing', async () => {
  const m = await meetingWith('SN-ALREADY==');
  await say(m.meetingId, 'Hello.');
  await share(m, true);
  const res = await call('POST', m.meetingId, 'notes-request', { headers: m.participant, body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'already_shared');
  assert.equal(res.cache, 'no-store');
  assert.deepEqual((await call('GET', m.meetingId, 'approvals', { headers: m.owner })).body, { approvals: [] });
  // it did not count as having asked
  await share(m, false);
  assert.equal((await call('POST', m.meetingId, 'notes-request', { headers: m.participant, body: {} })).status, 200);
});

test('when the meeting\'s data is flushed the notes are shared with nobody', async () => {
  const m = await meetingWith('SN-FLUSH==');
  const ownerPanel = await panel(m.meetingId, m.owner);
  await sayMany(m.meetingId, 5);
  await h.wait(150);
  await share(m, true);
  assert.equal((await getNotes(m, m.guest)).status, 200);

  await status(m.meetingId, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  assert.equal(getMeetingStore().getMeta(m.meetingId).notesShared, false);
  for (const headers of [m.owner, m.participant, m.guest]) {
    assert.equal((await call('GET', m.meetingId, 'state', { headers })).body.notesShared, false);
    assert.equal((await getNotes(m, headers)).status, 403);
  }
  // nobody owns a meeting that is over: it cannot be shared again
  assert.equal((await share(m, true)).status, 403);
  // the same meeting id running again starts unshared
  await status(m.meetingId, { status: 'rtms_started', streamId: 's1', operatorId: m.ana.zoomUserId });
  await h.wait(50);
  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).body.notesShared, false);
  closeAll(ownerPanel);
});

test('a change of sharing is logged without names, ids or notes', async () => {
  const lines = [];
  const original = {};
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    original[level] = console[level];
    console[level] = (...args) => lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  }
  let m;
  try {
    m = await meetingWith('SN-LOGS==');
    const ownerPanel = await panel(m.meetingId, m.owner);
    const benPanel = await panel(m.meetingId, m.participant);
    await sayMany(m.meetingId, 5);
    await h.wait(150);
    await share(m, true);
    await share(m, true);
    await getNotes(m, m.participant);
    await getNotes(m, m.guest);
    await share(m, false);
    await getNotes(m, m.participant); // 403
    await share(m, true, m.participant); // 403
    await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { shareNotes: 'Ana Ruiz' } }); // 400
    const { id } = (await call('POST', m.meetingId, 'notes-request', { headers: m.participant, body: {} })).body;
    await call('POST', m.meetingId, `approvals/${id}`, { headers: m.owner, body: { approve: true } });
    await call('POST', m.meetingId, 'notes-request', { headers: m.third, body: {} }); // 409
    await h.wait(100);
    closeAll(ownerPanel, benPanel);
  } finally {
    Object.assign(console, original);
  }
  const logged = lines.join('\n');
  assert.equal(lines.filter((line) => line === 'Arlo setting changed: notes sharing on').length, 2);
  assert.equal(lines.filter((line) => line === 'Arlo setting changed: notes sharing off').length, 1);
  for (const personal of ['Ben Okafor', 'Dee Marsh', 'Ana Ruiz', 'Okafor', 'Friday', 'line 1', m.ben.user.id, m.dee.user.id, m.ana.user.id, m.ana.zoomUserId]) {
    assert.equal(logged.includes(personal), false, 'logged something personal');
  }
});
