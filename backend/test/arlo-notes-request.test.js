// A participant asks the owner to share the notes; an owner answers. The
// server opens and closes the approval and tells the right panels. Approving
// turns sharing the notes on for everyone (test/arlo-share-notes.test.js).
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const openrouter = require('../src/services/openrouter');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { getApprovals } = require('../src/services/approvals');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let srv;
const realNotes = openrouter.generateLiveNotes;
test.before(async () => {
  openrouter.generateLiveNotes = async () => ({ summary: 'They ship Friday.', decisions: ['Ship Friday'], actionItems: [] });
  srv = await h.startServer();
});
test.after(() => {
  openrouter.generateLiveNotes = realNotes;
  srv.server.closeAllConnections?.();
  srv.server.close();
});

const internal = { 'x-arlo-internal-key': h.internalKey() };
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
const say = (meetingId, seqNo, text) => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, streamId: 's1', segment: { seqNo, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: 1000, tEndMs: 1000 } },
  internal,
);

let people = 0;
function person(displayName) {
  people += 1;
  const zoomUserId = `zoom-notes-request-${people}`;
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

async function call(method, meetingId, path, { headers = {}, body, raw } = {}) {
  const res = await fetch(url(meetingId, path), {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, cache: res.headers.get('cache-control') };
}

/**
 * A meeting Ana brought Arlo into, with Ben and Dee in it as signed-in
 * participants. `secondOwner`: Cy runs a stream of his own too.
 */
async function meetingWith(meetingId, { secondOwner = false, benName = 'Ben Okafor' } = {}) {
  const ana = person('Ana Ruiz');
  const ben = person(benName);
  const dee = person('Dee Marsh');
  const cy = person('Cy Young');
  const pass = await access(meetingId);
  await status(meetingId, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  if (secondOwner) await status(meetingId, { status: 'rtms_started', streamId: 's2', operatorId: cy.zoomUserId });
  await say(meetingId, 1, 'We ship on Friday.');
  return {
    meetingId, ana, ben, dee, cy, pass,
    owner: cookies(pass, ana.session),
    owner2: cookies(pass, cy.session),
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
const approvalMessages = (ws) => ws.messages.filter((msg) => msg.type.startsWith('arlo.approval'));
const closeAll = (...panels) => panels.forEach((ws) => ws.socket.close());
const requestNotes = (m, headers = m.participant) => call('POST', m.meetingId, 'notes-request', { headers, body: {} });
const answer = (m, id, body, headers = m.owner) => call('POST', m.meetingId, `approvals/${id}`, { headers, body });

test('the three routes need the meeting-access cookie for exactly that meeting and a signed-in user; nothing is cached', async () => {
  const m = await meetingWith('NR-GUARD==');
  const otherPass = await access('NR-GUARD-OTHER==');
  const id = crypto.randomUUID();
  const routes = [
    ['POST', 'notes-request', {}, m.ben.session],
    ['POST', `approvals/${id}`, { approve: false }, m.ana.session],
    ['GET', 'approvals', undefined, m.ana.session],
  ];
  for (const [method, path, body, session] of routes) {
    const none = await call(method, m.meetingId, path, { body });
    assert.equal(none.status, 401, `${method} ${path} without cookies`);
    assert.equal(none.cache, 'no-store');
    assert.equal((await call(method, m.meetingId, path, { body, headers: cookies(session) })).status, 401, `${method} ${path} without meeting access`);
    const wrong = await call(method, m.meetingId, path, { body, headers: cookies(otherPass, session) });
    assert.equal(wrong.status, 403, `${method} ${path} with another meeting's access`);
    assert.equal(wrong.cache, 'no-store');
    assert.equal((await call(method, m.meetingId, path, { body, headers: cookies('meetingAccess=not.a.token', session) })).status, 401);
    // in the meeting, not signed in
    const guest = await call(method, m.meetingId, path, { body, headers: m.guest });
    assert.equal(guest.status, 401, `${method} ${path} as a guest`);
    assert.equal((await call(method, m.meetingId, path, { body, headers: cookies(m.pass, 'sessionToken=forged.token.value') })).status, 401);
  }
  assert.deepEqual(getApprovals().listOpen(m.meetingId), []);
});

test('a request opens an approval and only the owners\' panels are told, with the asker\'s name', async () => {
  const m = await meetingWith('NR-ASK==');
  const [ownerPanel, askerPanel, thirdPanel, guestPanel] = await Promise.all([
    panel(m.meetingId, m.owner), panel(m.meetingId, m.participant), panel(m.meetingId, m.third), panel(m.meetingId, m.guest),
  ]);
  await h.wait(50);

  const before = Date.now();
  const res = await requestNotes(m);
  assert.equal(res.status, 200);
  assert.equal(res.cache, 'no-store');
  assert.deepEqual(Object.keys(res.body), ['id', 'expiresAt']);
  assert.match(res.body.id, UUID);
  assert.ok(res.body.expiresAt >= before + 60000 && res.body.expiresAt <= Date.now() + 60000);
  await h.wait(100);

  assert.deepEqual(approvalMessages(ownerPanel), [{
    type: 'arlo.approval',
    data: { meetingId: m.meetingId, id: res.body.id, kind: 'share_notes', askedBy: 'Ben Okafor', expiresAt: res.body.expiresAt },
  }]);
  for (const ws of [askerPanel, thirdPanel, guestPanel]) assert.deepEqual(approvalMessages(ws), []);
  closeAll(ownerPanel, askerPanel, thirdPanel, guestPanel);
});

test('an asker whose account has no name is "nobody by name"', async () => {
  for (const [meetingId, name] of [['NR-NONAME-1==', ''], ['NR-NONAME-2==', '   '], ['NR-NONAME-3==', '‮']]) {
    const m = await meetingWith(meetingId, { benName: name });
    const ownerPanel = await panel(m.meetingId, m.owner);
    const res = await requestNotes(m);
    assert.equal(res.status, 200);
    await h.wait(100);
    assert.equal(approvalMessages(ownerPanel)[0].data.askedBy, null);
    closeAll(ownerPanel);
  }
});

test('an owner\'s panel verified for another meeting is not told', async () => {
  const m = await meetingWith('NR-ELSEWHERE==');
  const otherPass = await access('NR-ELSEWHERE-OTHER==');
  // Ana's panel is open in another meeting; a restart of her stream lists it under this one too
  const elsewhere = await panel('NR-ELSEWHERE-OTHER==', cookies(otherPass, m.ana.session));
  await status(m.meetingId, { status: 'rtms_started', streamId: 's1', operatorId: m.ana.zoomUserId });
  const here = await panel(m.meetingId, m.owner);
  await h.wait(50);
  const res = await requestNotes(m);
  await answer(m, res.body.id, { approve: false });
  await h.wait(100);
  assert.equal(approvalMessages(here).length, 2);
  assert.deepEqual(approvalMessages(elsewhere), []);
  closeAll(elsewhere, here);
});

test('409 when the meeting has no owner or Arlo is not here; 400 for an owner', async () => {
  // nobody brought Arlo in
  const ben = person('Ben Okafor');
  const quietPass = await access('NR-QUIET==');
  const quiet = await call('POST', 'NR-QUIET==', 'notes-request', { headers: cookies(quietPass, ben.session), body: {} });
  assert.equal(quiet.status, 409);
  assert.equal(quiet.body.error, 'no_owner');

  // a stream runs, but its operator never signed in to Arlo
  const strangerPass = await access('NR-STRANGER==');
  await status('NR-STRANGER==', { status: 'rtms_started', streamId: 's1', operatorId: 'zoom-someone-not-in-arlo' });
  await say('NR-STRANGER==', 1, 'Hello.');
  const stranger = await call('POST', 'NR-STRANGER==', 'notes-request', { headers: cookies(strangerPass, ben.session), body: {} });
  assert.equal(stranger.status, 409);
  assert.equal(stranger.body.error, 'no_owner');

  // the owner's stream stopped (the meeting goes on): there is an owner, Arlo is not here
  const m = await meetingWith('NR-ABSENT==');
  const keepOpen = await panel(m.meetingId, m.owner);
  await status(m.meetingId, { status: 'rtms_stopped', streamId: 's1' });
  const absent = await requestNotes(m);
  assert.equal(absent.status, 409);
  assert.equal(absent.body.error, 'arlo_absent');
  assert.equal(absent.cache, 'no-store');
  // a refusal does not count as having asked
  await status(m.meetingId, { status: 'rtms_started', streamId: 's1', operatorId: m.ana.zoomUserId });
  assert.equal((await requestNotes(m)).status, 200);
  closeAll(keepOpen);

  // an owner has the notes
  const own = await meetingWith('NR-OWNER==', { secondOwner: true });
  assert.equal((await requestNotes(own, own.owner)).status, 400);
  assert.equal((await requestNotes(own, own.owner2)).status, 400);
  assert.deepEqual(getApprovals().listOpen(own.meetingId), []);
});

test('the request takes an empty JSON object and nothing else', async () => {
  const m = await meetingWith('NR-BODY==');
  const bad = [
    { kind: 'share_notes' }, { askedBy: 'Ana Ruiz' }, { userId: m.ana.user.id }, { notes: 'x' }, [], ['x'], 'please', 42, null,
  ];
  for (const body of bad) {
    const res = await call('POST', m.meetingId, 'notes-request', { headers: m.participant, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', m.meetingId, 'notes-request', { headers: m.participant, raw: '{"a":' })).status, 400);
  const form = await fetch(url(m.meetingId, 'notes-request'), {
    method: 'POST', headers: { ...m.participant, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1',
  });
  assert.equal(form.status, 415);
  assert.equal((await call('POST', m.meetingId, 'notes-request', { headers: m.participant })).status, 415);
  const text = await fetch(url(m.meetingId, 'notes-request'), {
    method: 'POST', headers: { ...m.participant, 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(text.status, 415);
  assert.deepEqual(getApprovals().listOpen(m.meetingId), []);
  // and none of the refusals counted as having asked
  assert.equal((await requestNotes(m)).status, 200);
});

test('one request per person per meeting: 429 while it is open and for two minutes after', async () => {
  const m = await meetingWith('NR-RATE==');
  const first = await requestNotes(m);
  assert.equal(first.status, 200);
  const again = await requestNotes(m);
  assert.equal(again.status, 429);
  assert.equal(again.body.error, 'too_soon');
  assert.equal(again.cache, 'no-store');
  assert.equal(getApprovals().listOpen(m.meetingId).length, 1);

  assert.equal((await answer(m, first.body.id, { approve: false })).status, 200);
  assert.equal((await requestNotes(m)).status, 429);
  // another person in the meeting is not held back by it
  assert.equal((await requestNotes(m, m.third)).status, 200);
  // nor the same person in another meeting
  const other = await meetingWith('NR-RATE-OTHER==');
  assert.equal((await call('POST', other.meetingId, 'notes-request', { headers: cookies(other.pass, m.ben.session), body: {} })).status, 200);
});

test('only an owner answers; the answer is { approve } for a UUID, and a boolean done is ignored', async () => {
  const m = await meetingWith('NR-ANSWER-GUARD==');
  const { id } = (await requestNotes(m)).body;

  // not an owner: the asker, another participant
  assert.equal((await answer(m, id, { approve: true, done: true }, m.participant)).status, 403);
  assert.equal((await answer(m, id, { approve: true, done: true }, m.third)).status, 403);
  assert.equal((await call('GET', m.meetingId, 'approvals', { headers: m.participant })).status, 403);

  for (const notAnId of ['1', 'abc', `${id}x`, id.replace(/-/g, ''), id.toUpperCase().replace(/^./, 'g'), '__proto__', 'constructor']) {
    assert.equal((await answer(m, notAnId, { approve: false })).status, 400, notAnId);
  }
  const bad = [
    {}, { approve: 'true' }, { approve: 1 }, { approve: null }, { done: true }, { approve: true, done: 'yes' },
    { approve: true, done: null }, { approve: false, done: 'no' }, { approve: true, done: true, message: 'the notes' },
    { approve: true, done: true, byUserId: m.ana.user.id }, { approve: false, outcome: 'approved' }, [true], 'yes', true,
  ];
  for (const body of bad) {
    assert.equal((await answer(m, id, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('POST', m.meetingId, `approvals/${id}`, { headers: m.owner, raw: '{"approve":' })).status, 400);
  const form = await fetch(url(m.meetingId, `approvals/${id}`), {
    method: 'POST', headers: { ...m.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'approve=true&done=true',
  });
  assert.equal(form.status, 415);

  // still open after all of that
  assert.equal(getApprovals().listOpen(m.meetingId).length, 1);
  // an id nothing is open under
  const unknown = await answer(m, crypto.randomUUID(), { approve: false });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.cache, 'no-store');

  const ok = await answer(m, id, { approve: false, done: false });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { id, outcome: 'declined' });
  assert.equal(ok.cache, 'no-store');
});

test('each outcome is told to the owners and to the person who asked, and to nobody else', async () => {
  const cases = [
    [{ approve: false }, 'declined'],
    [{ approve: true, done: true }, 'approved'],
    [{ approve: true }, 'approved'],
  ];
  let n = 0;
  for (const [body, outcome] of cases) {
    n += 1;
    const m = await meetingWith(`NR-OUTCOME-${n}==`, { secondOwner: true });
    const [ownerPanel, owner2Panel, askerPanel, thirdPanel, guestPanel] = await Promise.all([
      panel(m.meetingId, m.owner), panel(m.meetingId, m.owner2), panel(m.meetingId, m.participant),
      panel(m.meetingId, m.third), panel(m.meetingId, m.guest),
    ]);
    await h.wait(50);
    const { id } = (await requestNotes(m)).body;
    const res = await answer(m, id, body);
    assert.deepEqual(res.body, { id, outcome });
    await h.wait(100);

    const closed = { type: 'arlo.approval.closed', data: { meetingId: m.meetingId, id, outcome } };
    assert.deepEqual(approvalMessages(ownerPanel).map((msg) => msg.type), ['arlo.approval', 'arlo.approval.closed']);
    assert.deepEqual(approvalMessages(ownerPanel)[1], closed);
    assert.deepEqual(approvalMessages(owner2Panel)[1], closed);
    // the asker gets the outcome and no request details; notes only when the owner agreed to share them
    assert.deepEqual(approvalMessages(askerPanel), [closed]);
    if (outcome === 'declined') {
      assert.equal(askerPanel.messages.some((msg) => msg.type === 'notes.updated'), false);
      assert.equal(JSON.stringify(askerPanel.messages).includes('Friday'), false);
    }
    assert.deepEqual(approvalMessages(thirdPanel), []);
    assert.deepEqual(approvalMessages(guestPanel), []);
    closeAll(ownerPanel, owner2Panel, askerPanel, thirdPanel, guestPanel);
  }
});

test('with two owners the first answer wins', async () => {
  const m = await meetingWith('NR-TWO-OWNERS==', { secondOwner: true });
  const [ownerPanel, owner2Panel, askerPanel] = await Promise.all([
    panel(m.meetingId, m.owner), panel(m.meetingId, m.owner2), panel(m.meetingId, m.participant),
  ]);
  await h.wait(50);
  const { id } = (await requestNotes(m)).body;
  await h.wait(50);
  assert.equal(approvalMessages(ownerPanel).length, 1);
  assert.equal(approvalMessages(owner2Panel).length, 1);

  const [a, b] = await Promise.all([
    answer(m, id, { approve: true, done: true }, m.owner),
    answer(m, id, { approve: false }, m.owner2),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 404]);
  const won = a.status === 200 ? a : b;
  await h.wait(100);
  for (const ws of [ownerPanel, owner2Panel, askerPanel]) {
    const closes = approvalMessages(ws).filter((msg) => msg.type === 'arlo.approval.closed');
    assert.equal(closes.length, 1);
    assert.equal(closes[0].data.outcome, won.body.outcome);
  }
  assert.equal((await answer(m, id, { approve: false })).status, 404);
  closeAll(ownerPanel, owner2Panel, askerPanel);
});

test('an owner\'s panel that reloads reads the open approvals', async () => {
  const m = await meetingWith('NR-LIST==', { secondOwner: true });
  assert.deepEqual((await call('GET', m.meetingId, 'approvals', { headers: m.owner })).body, { approvals: [] });
  const first = (await requestNotes(m)).body;
  const second = (await requestNotes(m, m.third)).body;

  const list = await call('GET', m.meetingId, 'approvals', { headers: m.owner2 });
  assert.equal(list.status, 200);
  assert.equal(list.cache, 'no-store');
  assert.deepEqual(list.body, {
    approvals: [
      { meetingId: m.meetingId, id: first.id, kind: 'share_notes', askedBy: 'Ben Okafor', expiresAt: first.expiresAt },
      { meetingId: m.meetingId, id: second.id, kind: 'share_notes', askedBy: 'Dee Marsh', expiresAt: second.expiresAt },
    ],
  });
  await answer(m, first.id, { approve: false });
  assert.deepEqual((await call('GET', m.meetingId, 'approvals', { headers: m.owner })).body.approvals.map((one) => one.id), [second.id]);
});

test('when the meeting\'s data is flushed nothing is left, and a late answer is a 404', async () => {
  const m = await meetingWith('NR-FLUSH==');
  const { id } = (await requestNotes(m)).body;
  assert.equal(getApprovals().listOpen(m.meetingId).length, 1);
  const before = getApprovals().size();

  await status(m.meetingId, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  assert.deepEqual(getApprovals().listOpen(m.meetingId), []);
  assert.equal(getApprovals().get(m.meetingId, id), null);
  const after = getApprovals().size();
  assert.equal(after.meetings, before.meetings - 1);
  assert.equal(after.open, before.open - 1);
  assert.equal(after.askers, before.askers - 1);

  const late = await answer(m, id, { approve: true, done: true });
  assert.equal(late.status, 404);
  assert.equal(late.cache, 'no-store');
  // nobody owns a meeting that is over
  assert.equal((await call('GET', m.meetingId, 'approvals', { headers: m.owner })).status, 403);
  assert.equal((await requestNotes(m)).body.error, 'no_owner');
});

test('no name and no user id is logged, whatever happens', async () => {
  const lines = [];
  const original = {};
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    original[level] = console[level];
    console[level] = (...args) => lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  }
  let m;
  try {
    m = await meetingWith('NR-LOGS==', { secondOwner: true });
    const first = (await requestNotes(m)).body;
    await requestNotes(m); // 429
    await answer(m, first.id, { approve: true, done: true });
    await answer(m, first.id, { approve: false }); // 404
    await requestNotes(m, m.third); // 409: shared already
    await answer(m, first.id, { approve: true, done: true }, m.participant); // 403
    await requestNotes(m, m.owner); // 400
    await call('GET', m.meetingId, 'approvals', { headers: m.owner });
    await h.wait(50);
  } finally {
    Object.assign(console, original);
  }
  const logged = lines.join('\n');
  assert.match(logged, /approval/i); // something was logged about it
  for (const personal of ['Ben Okafor', 'Dee Marsh', 'Ana Ruiz', 'Cy Young', 'Ben', 'Okafor', m.ben.user.id, m.dee.user.id, m.ana.user.id, m.ben.zoomUserId]) {
    assert.equal(logged.includes(personal), false, 'logged something personal');
  }
});
