// Arlo's own routes for one meeting: what a panel is told, the meeting's one
// setting, the notes, and asking a question. Model calls are replaced: nothing
// leaves the machine.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const test = require('node:test');
const assert = require('node:assert/strict');
const openrouter = require('../src/services/openrouter');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { getMeetingStore } = require('../src/storage');

let srv;
const real = { notes: openrouter.generateLiveNotes, ask: openrouter.answerFromTranscript, choose: openrouter.chooseTool };
let asked;
let answer;
test.before(async () => { srv = await h.startServer(); });
// The AI limiter counts per client address (20 a minute). The app trusts one
// proxy hop, so each test asks from an address of its own.
let clientIp;
let testNo = 0;
test.beforeEach(() => {
  testNo += 1;
  clientIp = `10.9.0.${testNo}`;
  asked = [];
  answer = async () => 'On Friday.';
  openrouter.generateLiveNotes = async () => ({ summary: 'They ship Friday.', decisions: ['Ship Friday'], actionItems: [{ text: 'Release notes', owner: 'Ben' }] });
  openrouter.answerFromTranscript = async (input) => { asked.push(input); return answer(input); };
  // The model that picks a tool is not reachable in these tests: a typed
  // question is then answered as typed (test/agent-routes.test.js has the rest)
  openrouter.chooseTool = async () => { throw Object.assign(new Error('no models'), { code: 'no_models' }); };
});
test.after(() => {
  openrouter.generateLiveNotes = real.notes;
  openrouter.answerFromTranscript = real.ask;
  openrouter.chooseTool = real.choose;
  srv.server.closeAllConnections?.();
  srv.server.close();
});

const internal = { 'x-arlo-internal-key': h.internalKey() };
const say = (meetingId, text, speakerLabel = 'Ana') => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, streamId: 's1', segment: { seqNo: 1, text, speakerId: '7', speakerLabel, tStartMs: 1000, tEndMs: 1000 } },
  internal,
);
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);

let people = 0;
function person(displayName) {
  people += 1;
  const zoomUserId = `zoom-arlo-routes-${people}`;
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
      'x-forwarded-for': clientIp,
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, cache: res.headers.get('cache-control'), headers: res.headers };
}

/** A meeting Ana brought Arlo into, with `lines` lines said, and Ben in it as a signed-in participant. */
async function meetingWith(meetingId, lines = 2) {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  const pass = await access(meetingId);
  await status(meetingId, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  const said = ['We ship on Friday.', 'I will write the release notes.', 'Good.', 'Anything else?', 'No.', 'Then we are done.'];
  for (let i = 0; i < lines; i += 1) await say(meetingId, said[i % said.length], i % 2 === 0 ? 'Ana' : 'Ben');
  await h.wait(50);
  return {
    meetingId, ana, ben, pass, owner: cookies(pass, ana.session), participant: cookies(pass, ben.session), guest: cookies(pass),
  };
}

const ROUTES = [['GET', 'state'], ['PUT', 'settings'], ['GET', 'notes'], ['POST', 'ask']];
const BODIES = { settings: { whoCanAsk: 'anyone' }, ask: { question: 'When do we ship?' } };

test('every route needs the meeting-access cookie for exactly that meeting, and nothing is cached', async () => {
  const m = await meetingWith('ARLO-GUARD==');
  const otherPass = await access('ARLO-GUARD-OTHER==');

  for (const [method, path] of ROUTES) {
    const body = BODIES[path];
    // no cookie at all
    const none = await call(method, m.meetingId, path, { body });
    assert.equal(none.status, 401, `${method} ${path} without cookies`);
    assert.equal(none.cache, 'no-store', `${method} ${path} 401`);
    // signed in, but not verified to be in any meeting
    const noPass = await call(method, m.meetingId, path, { body, headers: cookies(m.ana.session) });
    assert.equal(noPass.status, 401, `${method} ${path} without meeting access`);
    // signed in as the owner, but the meeting access is for another meeting
    const wrong = await call(method, m.meetingId, path, { body, headers: cookies(otherPass, m.ana.session) });
    assert.equal(wrong.status, 403, `${method} ${path} with another meeting's access`);
    assert.equal(wrong.cache, 'no-store', `${method} ${path} 403`);
    // a forged meeting-access cookie
    const forged = await call(method, m.meetingId, path, { body, headers: cookies('meetingAccess=not.a.token', m.ana.session) });
    assert.equal(forged.status, 401, `${method} ${path} with a forged cookie`);
    // and it works for the owner, uncached
    const ok = await call(method, m.meetingId, path, { body, headers: m.owner });
    assert.equal(ok.status, 200, `${method} ${path} as the owner`);
    assert.equal(ok.cache, 'no-store', `${method} ${path} 200`);
  }
  assert.equal(asked.length, 1); // only the owner's own question reached the model
});

test('settings and ask need a signed-in user; state does not, and the notes are refused to a guest while they are not shared', async () => {
  const m = await meetingWith('ARLO-SIGNIN==');
  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).status, 200);
  assert.equal((await call('PUT', m.meetingId, 'settings', { headers: m.guest, body: BODIES.settings })).status, 401);
  // in the meeting, not an owner, notes not shared (test/arlo-share-notes.test.js has the shared case)
  assert.equal((await call('GET', m.meetingId, 'notes', { headers: m.guest })).status, 403);
  assert.equal((await call('POST', m.meetingId, 'ask', { headers: m.guest, body: BODIES.ask })).status, 401);
  // a session cookie that does not verify is not a user
  const bad = cookies(m.pass, 'sessionToken=forged.token.value');
  assert.equal((await call('GET', m.meetingId, 'notes', { headers: bad })).status, 403);
  assert.equal((await call('GET', m.meetingId, 'state', { headers: bad })).body.role, 'participant');
  assert.equal(asked.length, 0);
});

test('state tells each person what they are to Arlo', async () => {
  const m = await meetingWith('ARLO-STATE==');
  const owner = await call('GET', m.meetingId, 'state', { headers: m.owner });
  assert.deepEqual(owner.body, { present: true, paused: false, myStreamPaused: false, myStreamLive: true, role: 'owner', ownerName: 'Ana Ruiz', whoCanAsk: 'owner', notesShared: false });
  const participant = await call('GET', m.meetingId, 'state', { headers: m.participant });
  assert.deepEqual(participant.body, { present: true, paused: false, role: 'participant', ownerName: 'Ana Ruiz', whoCanAsk: 'owner', notesShared: false });
  const guest = await call('GET', m.meetingId, 'state', { headers: m.guest });
  assert.deepEqual(guest.body, participant.body);

  // a meeting Arlo is not in
  const quietPass = await access('ARLO-STATE-QUIET==');
  const quiet = await call('GET', 'ARLO-STATE-QUIET==', 'state', { headers: cookies(quietPass, m.ana.session) });
  assert.deepEqual(quiet.body, { present: false, paused: false, role: 'participant', ownerName: null, whoCanAsk: 'owner', notesShared: false });
});

test('only an owner changes who can ask; every panel is told', async () => {
  const m = await meetingWith('ARLO-SETTINGS==');
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(m.meetingId)}`, m.participant);
  await h.wait(100);

  const refused = await call('PUT', m.meetingId, 'settings', { headers: m.participant, body: { whoCanAsk: 'anyone' } });
  assert.equal(refused.status, 403);
  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).body.whoCanAsk, 'owner');

  const changed = await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { whoCanAsk: 'anyone' } });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, { present: true, paused: false, myStreamPaused: false, myStreamLive: true, role: 'owner', ownerName: 'Ana Ruiz', whoCanAsk: 'anyone', notesShared: false });
  assert.equal(getMeetingStore().getMeta(m.meetingId).whoCanAsk, 'anyone');
  await h.wait(100);
  ws.socket.close();
  const told = ws.messages.filter((msg) => msg.type === 'arlo.state').map((msg) => msg.data);
  assert.deepEqual(told.at(-1), {
    meetingId: m.meetingId, present: true, paused: false, role: 'participant', ownerName: 'Ana Ruiz', whoCanAsk: 'anyone', notesShared: false,
  });
});

test('settings accept exactly { whoCanAsk: "owner" | "anyone" }', async () => {
  const m = await meetingWith('ARLO-SETTINGS-BAD==');
  const bad = [
    {}, { whoCanAsk: 'everyone' }, { whoCanAsk: '' }, { whoCanAsk: null }, { whoCanAsk: ['anyone'] },
    { whoCanAsk: { $ne: 'owner' } }, { whoCanAsk: true }, { whoCanAsk: 'anyone', ownerUserId: 'someone-else' },
    { whoCanAsk: 'anyone', __proto__: { x: 1 }, extra: 1 }, ['anyone'], 'anyone',
  ];
  for (const body of bad) {
    const res = await call('PUT', m.meetingId, 'settings', { headers: m.owner, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await call('PUT', m.meetingId, 'settings', { headers: m.owner, raw: '{"whoCanAsk":' })).status, 400);
  // a form post is not accepted: only JSON
  const form = await fetch(url(m.meetingId, 'settings'), {
    method: 'PUT', headers: { ...m.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'whoCanAsk=anyone',
  });
  assert.equal(form.status, 415);
  assert.equal(getMeetingStore().getMeta(m.meetingId).whoCanAsk, 'owner');

  assert.equal((await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { whoCanAsk: 'anyone' } })).status, 200);
  assert.equal((await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { whoCanAsk: 'owner' } })).status, 200);
});

test('the notes are for owners only', async () => {
  const m = await meetingWith('ARLO-NOTES==', 5); // five lines: the notes are written
  // once the owner has a panel open in the meeting to read them
  assert.deepEqual((await call('GET', m.meetingId, 'notes', { headers: m.owner })).body, { notes: null });
  const panel = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(m.meetingId)}`, m.owner);
  assert.equal(panel.open, true);
  await h.wait(100);
  panel.socket.close();
  const owner = await call('GET', m.meetingId, 'notes', { headers: m.owner });
  assert.equal(owner.status, 200);
  assert.deepEqual(Object.keys(owner.body), ['notes']);
  assert.equal(owner.body.notes.summary, 'They ship Friday.');
  assert.deepEqual(owner.body.notes.decisions, ['Ship Friday']);
  assert.deepEqual(owner.body.notes.actionItems, [{ text: 'Release notes', owner: 'Ben' }]);
  assert.equal(owner.body.notes.throughSeqNo, 5);
  assert.equal(typeof owner.body.notes.updatedAt, 'number');

  const participant = await call('GET', m.meetingId, 'notes', { headers: m.participant });
  assert.equal(participant.status, 403);
  assert.equal(JSON.stringify(participant.body).includes('Friday'), false);

  // "anyone can ask" does not open the notes
  await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { whoCanAsk: 'anyone' } });
  assert.equal((await call('GET', m.meetingId, 'notes', { headers: m.participant })).status, 403);

  // no notes yet
  const early = await meetingWith('ARLO-NOTES-EARLY==', 1);
  assert.deepEqual((await call('GET', early.meetingId, 'notes', { headers: early.owner })).body, { notes: null });
});

test('ask answers from the stored transcript, and only for who may ask', async () => {
  const m = await meetingWith('ARLO-ASK==');

  const refused = await call('POST', m.meetingId, 'ask', { headers: m.participant, body: BODIES.ask });
  assert.equal(refused.status, 403);
  assert.equal(asked.length, 0);

  const owner = await call('POST', m.meetingId, 'ask', { headers: m.owner, body: { question: '  When do we ship?  ' } });
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body, { answer: 'On Friday.' });
  assert.equal(owner.headers.get('ratelimit-limit'), '20'); // the AI limiter is on this route
  assert.equal(asked.length, 1);
  assert.equal(asked[0].question, 'When do we ship?');
  assert.deepEqual(asked[0].lines, ['Ana: We ship on Friday.', 'Ben: I will write the release notes.']);

  await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { whoCanAsk: 'anyone' } });
  const allowed = await call('POST', m.meetingId, 'ask', { headers: m.participant, body: BODIES.ask });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body, { answer: 'On Friday.' });

  // nothing about the question or the answer is kept with the meeting
  const store = getMeetingStore();
  assert.equal(store.listSegments(m.meetingId).length, 2);
  assert.equal(JSON.stringify([store.getNotes(m.meetingId), store.getMeta(m.meetingId), store.listEvents(m.meetingId)]).includes('When do we ship'), false);
});

test('ask never takes a transcript, a model or anything else from the client', async () => {
  const m = await meetingWith('ARLO-ASK-BODY==');
  const bad = [
    {}, { question: '' }, { question: '   ' }, { question: 'q'.repeat(501) }, { question: 42 }, { question: null },
    { question: ['When?'] }, { question: { $gt: '' } },
    { question: 'When?', transcript: 'Ana: we ship never.' },
    { question: 'When?', model: 'paid/model' },
    { question: 'When?', meetingId: 'ANOTHER==' },
    ['When?'],
  ];
  for (const body of bad) {
    const res = await call('POST', m.meetingId, 'ask', { headers: m.owner, body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(asked.length, 0);

  const longest = await call('POST', m.meetingId, 'ask', { headers: m.owner, body: { question: 'q'.repeat(500) } });
  assert.equal(longest.status, 200);
  assert.deepEqual(asked[0].lines, ['Ana: We ship on Friday.', 'Ben: I will write the release notes.']);
});

test('ask with nothing said yet is a 409, and a failing model is reported without its error', async () => {
  const ana = person('Ana Ruiz');
  const meetingId = 'ARLO-ASK-EMPTY==';
  const pass = await access(meetingId);
  await status(meetingId, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  const owner = cookies(pass, ana.session);
  const empty = await call('POST', meetingId, 'ask', { headers: owner, body: BODIES.ask });
  assert.equal(empty.status, 409);
  assert.equal(empty.body.error, 'no_transcript');
  assert.equal(asked.length, 0);

  await say(meetingId, 'We ship on Friday.');
  answer = async () => { throw Object.assign(new Error('rate limited'), { code: 'rate_limited' }); };
  const limited = await call('POST', meetingId, 'ask', { headers: owner, body: BODIES.ask });
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /rate limited/);

  answer = async () => { throw new Error('upstream 401: key sk-secret invalid, transcript: We ship on Friday.'); };
  const failed = await call('POST', meetingId, 'ask', { headers: owner, body: BODIES.ask });
  assert.equal(failed.status, 502);
  assert.equal(/sk-secret|Friday/.test(JSON.stringify(failed.body)), false);

  for (const notAnAnswer of ['', '   ', null, 42, { text: 'x' }]) {
    answer = async () => notAnAnswer;
    assert.equal((await call('POST', meetingId, 'ask', { headers: owner, body: BODIES.ask })).status, 502);
  }
  answer = async () => `  ${'a'.repeat(9000)}  `;
  const long = await call('POST', meetingId, 'ask', { headers: owner, body: BODIES.ask });
  assert.equal(long.status, 200);
  assert.equal(long.body.answer.length, 4000);
});

test('ask sends the newest lines when the transcript is long', async () => {
  const meetingId = 'ARLO-ASK-LONG==';
  const ana = person('Ana Ruiz');
  const pass = await access(meetingId);
  await status(meetingId, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  const store = getMeetingStore();
  for (let i = 1; i <= 40; i += 1) store.appendSegment(meetingId, { text: `${i} ${'x'.repeat(990)}`, speakerLabel: 'Ana' });
  const res = await call('POST', meetingId, 'ask', { headers: cookies(pass, ana.session), body: BODIES.ask });
  assert.equal(res.status, 200);
  const { lines } = asked[0];
  assert.ok(lines.join('\n').length <= 12000);
  assert.ok(lines.length >= 10 && lines.length < 40);
  assert.ok(lines.at(-1).startsWith('Ana: 40 '));
});

test('after the meeting ended there is no owner, no notes and nothing to ask about', async () => {
  const m = await meetingWith('ARLO-ENDED==', 5);
  await h.wait(100);
  await status(m.meetingId, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });

  assert.deepEqual(
    (await call('GET', m.meetingId, 'state', { headers: m.owner })).body,
    { present: false, paused: false, role: 'participant', ownerName: null, whoCanAsk: 'owner', notesShared: false },
  );
  assert.equal((await call('GET', m.meetingId, 'notes', { headers: m.owner })).status, 403);
  assert.equal((await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: BODIES.settings })).status, 403);
  assert.equal((await call('POST', m.meetingId, 'ask', { headers: m.owner, body: BODIES.ask })).status, 403);
  assert.equal(asked.length, 0);
});

test('ask: a meeting flushed while the model was answering gets no answer', async () => {
  const m = await meetingWith('ARLO-ASK-FLUSHED==');
  answer = async () => {
    await status(m.meetingId, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
    return 'On Friday.';
  };
  const res = await call('POST', m.meetingId, 'ask', { headers: m.owner, body: BODIES.ask });
  assert.equal(asked.length, 1);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'no_transcript');
  assert.equal(JSON.stringify(res.body).includes('Friday'), false);
  assert.equal(res.cache, 'no-store');
});
