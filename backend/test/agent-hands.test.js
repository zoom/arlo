// The hands: an action that needs the Zoom Apps SDK is sent to one owner's
// open panel, which reports the result. First the service on its own (the
// clock, the timers and the panels are the test's), then through the running
// server with real sockets and cookies. Nothing here touches the network.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const openrouter = require('../src/services/openrouter');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { createHands, readHandsAnnouncement, RESULT_CODES } = require('../src/services/agent/hands');
const { getAgentRuntime } = require('../src/services/agent');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const M = 'MEETING-HANDS==';

// ---------------------------------------------------------------------------
// The service on its own
// ---------------------------------------------------------------------------

function setup(options = {}) {
  let clock = 1_000_000;
  const timers = [];
  const t = { owners: ['user-ana', 'user-cy'], panels: [] };
  const hands = createHands({
    panels: (meetingId) => (meetingId === M ? t.panels : []),
    isOwner: (meetingId, userId) => meetingId === M && t.owners.includes(userId),
    now: () => clock,
    schedule: (fn, ms) => {
      const timer = { fn, at: clock + ms, cancelled: false, done: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    ...options,
  });
  const advance = (ms) => {
    clock += ms;
    for (const timer of [...timers]) {
      if (!timer.cancelled && !timer.done && timer.at <= clock) {
        timer.done = true;
        timer.fn();
      }
    }
  };
  /** A panel that announced what it can do; what it was sent is in `.got`. */
  const panel = (userId, zoomRole, can, since = clock, works = true) => {
    const one = {
      userId, zoomRole, can, since, got: [], send(message) { one.got.push(message); return works; },
    };
    t.panels.push(one);
    return one;
  };
  const live = () => timers.filter((timer) => !timer.cancelled && !timer.done).length;
  return {
    hands, t, panel, advance, live,
  };
}
const POST = { tool: 'post_to_chat', args: { message: 'Back in five.' } };
const ADMIT = { tool: 'admit_from_waiting_room', args: { name: 'James' } };

test('an action goes to one panel, and its result is the outcome', async () => {
  const s = setup();
  const ana = s.panel('user-ana', 'host', ['post_to_chat']);
  const running = s.hands.run(M, POST);
  assert.equal(ana.got.length, 1);
  const { type, data } = ana.got[0];
  assert.equal(type, 'arlo.action');
  assert.match(data.actionId, UUID);
  assert.deepEqual(data, { meetingId: M, actionId: data.actionId, tool: 'post_to_chat', args: { message: 'Back in five.' } });
  assert.equal(s.hands.pending(), 1);

  assert.equal(s.hands.result(M, data.actionId, 'user-ana', { ok: true }), true);
  assert.deepEqual(await running, { ok: true });
  assert.equal(s.hands.pending(), 0);
  assert.equal(s.live(), 0);

  // every code a panel may report is passed on; anything else is "the SDK failed"
  assert.deepEqual([...RESULT_CODES], ['not_found', 'several_match', 'no_notes', 'sdk_error', 'unsupported', 'not_allowed']);
  for (const [code, expected] of [...RESULT_CODES].map((one) => [one, one]).concat([[undefined, 'sdk_error'], ['rm -rf', 'sdk_error'], [5, 'sdk_error']])) {
    const again = s.hands.run(M, POST);
    s.hands.result(M, ana.got.at(-1).data.actionId, 'user-ana', { ok: false, code });
    assert.deepEqual(await again, { ok: false, code: expected });
  }
});

test('which panel: it must be an owner\'s and list the tool; a host or co-host first, then the oldest', async () => {
  const s = setup();
  const guest = s.panel(null, 'host', ['post_to_chat'], 1);
  const ben = s.panel('user-ben', 'host', ['post_to_chat'], 2); // signed in, not an owner
  const cannot = s.panel('user-ana', 'host', ['admit_from_waiting_room'], 3);
  const attendee = s.panel('user-ana', 'attendee', ['post_to_chat'], 4);
  const laterHost = s.panel('user-cy', 'coHost', ['post_to_chat', 'admit_from_waiting_room'], 6);
  const host = s.panel('user-cy', 'host', ['post_to_chat'], 5);

  s.hands.run(M, POST);
  assert.equal(host.got.length, 1);
  for (const other of [guest, ben, cannot, attendee, laterHost]) assert.equal(other.got.length, 0);

  // nobody who is host or co-host can: the oldest of the others
  s.t.panels.splice(s.t.panels.indexOf(host), 1);
  s.t.panels.splice(s.t.panels.indexOf(laterHost), 1);
  s.hands.run(M, POST);
  assert.equal(attendee.got.length, 1);

  // someone stops being an owner: their panel is not used, whatever it announced
  s.t.owners = ['user-cy'];
  assert.deepEqual(await s.hands.run(M, POST), { ok: false, code: 'no_hands' });
  assert.equal(attendee.got.length, 1);
});

test('admitting from the waiting room needs a host or co-host', async () => {
  const s = setup();
  const attendee = s.panel('user-ana', 'attendee', ['admit_from_waiting_room', 'post_to_chat'], 1);
  assert.deepEqual(await s.hands.run(M, ADMIT), { ok: false, code: 'no_hands' });
  assert.equal(attendee.got.length, 0);
  const coHost = s.panel('user-cy', 'coHost', ['admit_from_waiting_room'], 2);
  s.hands.run(M, ADMIT);
  assert.equal(coHost.got.length, 1);
  assert.deepEqual(coHost.got[0].data.args, { name: 'James' });
});

test('no panel, a tool that is not a panel\'s, or a call that is not one: nothing is sent', async () => {
  const s = setup();
  assert.deepEqual(await s.hands.run(M, POST), { ok: false, code: 'no_hands' });
  const ana = s.panel('user-ana', 'host', ['post_to_chat', 'share_notes', 'answer_from_meeting']);
  assert.deepEqual(await s.hands.run('ANOTHER==', POST), { ok: false, code: 'no_hands' });
  for (const call of [
    { tool: 'share_notes', args: {} }, { tool: 'answer_from_meeting', args: { question: 'x' } }, { tool: 'delete_everything', args: {} },
    { tool: 'post_to_chat' }, { tool: 'post_to_chat', args: 'hello' }, { tool: 5, args: {} }, null, undefined, 'post_to_chat',
  ]) {
    assert.deepEqual(await s.hands.run(M, call), { ok: false, code: 'unsupported' }, JSON.stringify(call));
  }
  for (const meetingId of ['', null, 5]) assert.deepEqual(await s.hands.run(meetingId, POST), { ok: false, code: 'no_hands' });
  assert.equal(ana.got.length, 0);
  assert.equal(s.hands.pending(), 0);
});

test('a panel that cannot be sent to is passed over', async () => {
  const s = setup();
  const broken = s.panel('user-ana', 'host', ['post_to_chat'], 1, false);
  const thrower = s.panel('user-ana', 'host', ['post_to_chat'], 2);
  thrower.send = () => { throw new Error('socket closed'); };
  const works = s.panel('user-cy', 'attendee', ['post_to_chat'], 3);
  const running = s.hands.run(M, POST);
  assert.equal(broken.got.length, 1);
  assert.equal(works.got.length, 1);
  // only the panel that got it may answer
  assert.equal(s.hands.result(M, broken.got[0].data.actionId, 'user-ana', { ok: true }), false);
  assert.equal(s.hands.result(M, works.got[0].data.actionId, 'user-ana', { ok: true }), false);
  assert.equal(s.hands.result(M, works.got[0].data.actionId, 'user-cy', { ok: true }), true);
  assert.deepEqual(await running, { ok: true });

  s.t.panels.pop();
  assert.deepEqual(await s.hands.run(M, POST), { ok: false, code: 'no_hands' });
  assert.equal(s.hands.pending(), 0);
});

test('a result is taken once, from the user it was sent to, for the meeting it was sent in', async () => {
  const s = setup();
  const ana = s.panel('user-ana', 'host', ['post_to_chat']);
  const running = s.hands.run(M, POST);
  const { actionId } = ana.got[0].data;
  const refusedOnes = [
    [M, actionId, 'user-cy', { ok: true }], // another owner
    [M, actionId, 'user-ben', { ok: true }],
    [M, actionId, null, { ok: true }],
    ['ANOTHER==', actionId, 'user-ana', { ok: true }],
    [M, crypto.randomUUID(), 'user-ana', { ok: true }],
    [M, 'not-an-id', 'user-ana', { ok: true }],
    [M, actionId, 'user-ana', { ok: 'yes' }],
    [M, actionId, 'user-ana', null],
    [M, actionId, 'user-ana', undefined],
  ];
  for (const args of refusedOnes) assert.equal(s.hands.result(...args), false, JSON.stringify(args));
  assert.equal(s.hands.pending(), 1);

  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: false, code: 'not_found' }), true);
  assert.deepEqual(await running, { ok: false, code: 'not_found' });
  // finished: a second result changes nothing
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: true }), false);

  // someone who stopped being an owner cannot report any more
  const next = s.hands.run(M, POST);
  s.t.owners = ['user-cy'];
  assert.equal(s.hands.result(M, ana.got[1].data.actionId, 'user-ana', { ok: true }), false);
  s.advance(15000);
  assert.deepEqual(await next, { ok: false, code: 'timeout' });
});

test('no result in 15 seconds is a timeout, and a late result is refused', async () => {
  const s = setup();
  const ana = s.panel('user-ana', 'host', ['post_to_chat']);
  const running = s.hands.run(M, POST);
  s.advance(14999);
  assert.equal(s.hands.pending(), 1);
  s.advance(1);
  assert.deepEqual(await running, { ok: false, code: 'timeout' });
  assert.equal(s.hands.pending(), 0);
  assert.equal(s.hands.result(M, ana.got[0].data.actionId, 'user-ana', { ok: true }), false);
});

test('at most ten actions wait for a panel per meeting', async () => {
  const s = setup();
  s.panel('user-ana', 'host', ['post_to_chat']);
  const waiting = [];
  for (let i = 0; i < 10; i += 1) waiting.push(s.hands.run(M, POST));
  assert.deepEqual(await s.hands.run(M, POST), { ok: false, code: 'busy' });
  assert.equal(s.hands.pending(), 10);
  s.advance(15000);
  assert.deepEqual(await Promise.all(waiting), new Array(10).fill({ ok: false, code: 'timeout' }));
});

test('the meeting is flushed: what waited ends as gone, and nothing is left', async () => {
  const s = setup();
  const ana = s.panel('user-ana', 'host', ['post_to_chat']);
  const running = s.hands.run(M, POST);
  s.hands.forget('ANOTHER==');
  assert.equal(s.hands.pending(), 1);
  s.hands.forget(M);
  assert.deepEqual(await running, { ok: false, code: 'gone' });
  assert.equal(s.hands.pending(), 0);
  assert.equal(s.live(), 0);
  assert.equal(s.hands.result(M, ana.got[0].data.actionId, 'user-ana', { ok: true }), false);
});

test('what a panel announces: a Zoom role and the panel tools it can run, nothing else', () => {
  const read = readHandsAnnouncement;
  assert.deepEqual(read({ zoomRole: 'host', can: ['post_to_chat', 'admit_from_waiting_room'] }), { zoomRole: 'host', can: ['post_to_chat', 'admit_from_waiting_room'] });
  assert.deepEqual(read({ zoomRole: 'coHost', can: [] }), { zoomRole: 'coHost', can: [] });
  assert.deepEqual(read({ zoomRole: 'panelist', can: ['post_to_chat'] }), { zoomRole: 'panelist', can: ['post_to_chat'] });
  // a role that is not known is an attendee's
  for (const zoomRole of ['attendee', 'owner', 'HOST', 'cohost', 'admin', '']) {
    assert.deepEqual(read({ zoomRole, can: ['post_to_chat'] }), { zoomRole: 'attendee', can: ['post_to_chat'] }, zoomRole);
  }
  // listed twice is listed once
  assert.deepEqual(read({ zoomRole: 'host', can: ['post_to_chat', 'post_to_chat'] }).can, ['post_to_chat']);
  for (const bad of [
    null, undefined, 'host', [], ['host'],
    { zoomRole: 'host' }, { can: ['post_to_chat'] }, { zoomRole: 'host', can: 'post_to_chat' },
    { zoomRole: 5, can: [] }, { zoomRole: null, can: [] }, { zoomRole: 'h'.repeat(33), can: [] },
    { zoomRole: 'host', can: ['share_notes'] }, { zoomRole: 'host', can: ['answer_from_meeting'] },
    { zoomRole: 'host', can: ['post_to_chat', 'delete_everything'] }, { zoomRole: 'host', can: [5] }, { zoomRole: 'host', can: [null] },
    { zoomRole: 'host', can: new Array(11).fill('post_to_chat') },
    { zoomRole: 'host', can: ['post_to_chat'], userId: 'user-ana' }, { zoomRole: 'host', can: [], role: 'owner' },
  ]) {
    assert.equal(read(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Through the running server
// ---------------------------------------------------------------------------

let srv;
const real = { notes: openrouter.generateLiveNotes, ask: openrouter.answerFromTranscript, choose: openrouter.chooseTool };
let pick;
let clientIp;
let testNo = 0;
test.before(async () => { srv = await h.startServer(); });
test.beforeEach(() => {
  testNo += 1;
  clientIp = `10.7.0.${testNo}`;
  pick = async () => ({ tool: 'post_to_chat', args: { message: 'Back in five.' } });
  openrouter.generateLiveNotes = async () => ({ summary: 'They ship Friday.', decisions: [], actionItems: [] });
  openrouter.answerFromTranscript = async () => 'On Friday.';
  openrouter.chooseTool = async (input) => pick(input);
});
test.after(() => {
  openrouter.generateLiveNotes = real.notes;
  openrouter.answerFromTranscript = real.ask;
  openrouter.chooseTool = real.choose;
  srv.server.closeAllConnections?.();
  srv.server.close();
});

const internal = { 'x-arlo-internal-key': h.internalKey() };
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
let lineNo = 0;
const say = (meetingId, text, { speakerId = '8', speakerLabel = 'Ben' } = {}) => {
  lineNo += 1;
  return h.postJson(
    `${srv.base}/api/rtms/broadcast`,
    { meetingId, streamId: 's1', segment: { seqNo: lineNo, text, speakerId, speakerLabel, tStartMs: lineNo * 1000, tEndMs: lineNo * 1000 } },
    internal,
  );
};
let people = 0;
function person(displayName) {
  people += 1;
  const zoomUserId = `zoom-agent-hands-${people}`;
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
async function call(method, meetingId, path, { headers = {}, body, raw, type = 'application/json' } = {}) {
  const res = await fetch(url(meetingId, path), {
    method,
    headers: { 'x-forwarded-for': clientIp, ...(body !== undefined || raw !== undefined ? { 'content-type': type } : {}), ...headers },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, cache: res.headers.get('cache-control') };
}
async function meetingWith(meetingId, { secondOwner = false } = {}) {
  const ana = person('Ana Ruiz');
  const cy = person('Cy Young');
  const ben = person('Ben Okafor');
  const pass = await access(meetingId);
  await status(meetingId, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  if (secondOwner) await status(meetingId, { status: 'rtms_started', streamId: 's2', operatorId: cy.zoomUserId });
  await say(meetingId, 'We ship on Friday.', { speakerId: '7', speakerLabel: 'Ana' });
  return {
    meetingId, ana, cy, ben, pass,
    owner: cookies(pass, ana.session),
    owner2: cookies(pass, cy.session),
    participant: cookies(pass, ben.session),
    guest: cookies(pass),
  };
}
/** A panel; with `hands` it announces them after subscribing, as the app does. */
async function panel(meetingId, headers, hands) {
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, headers);
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId } }));
  if (hands) ws.socket.send(JSON.stringify({ type: 'arlo.hands', payload: hands }));
  await h.wait(50);
  return ws;
}
const of = (ws, type) => ws.messages.filter((msg) => msg.type === type);
const closeAll = (...panels) => panels.forEach((ws) => ws.socket.close());
const ask = (m, question, headers = m.owner) => call('POST', m.meetingId, 'ask', { headers, body: { question } });
const report = (m, actionId, body, headers = m.owner) => call('POST', m.meetingId, `actions/${actionId}/result`, { headers, body });
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await h.wait(10);
  }
  return check();
}
const actionSent = (ws, n = 1) => until(() => (of(ws, 'arlo.action').length >= n ? of(ws, 'arlo.action')[n - 1].data : null));
const HOST = { zoomRole: 'host', can: ['post_to_chat', 'admit_from_waiting_room'] };
// What the owner types has the message in it: a message that is not in the typed text gets the sheet
const POST_IT = 'Post "Back in five." to the chat';

test('an owner types "post … to the chat": their panel gets the action, and its result is the answer', async () => {
  const m = await meetingWith('AH-POST==');
  const ownerPanel = await panel(m.meetingId, m.owner, HOST);
  const benPanel = await panel(m.meetingId, m.participant, HOST); // announces too; is not an owner
  const guestPanel = await panel(m.meetingId, m.guest, HOST);

  const asking = ask(m, 'Post "Back in five." to the chat');
  const sent = await actionSent(ownerPanel);
  assert.match(sent.actionId, UUID);
  assert.deepEqual(sent, { meetingId: m.meetingId, actionId: sent.actionId, tool: 'post_to_chat', args: { message: 'Arlo: Back in five.' } });
  for (const ws of [benPanel, guestPanel]) assert.deepEqual(of(ws, 'arlo.action'), []);

  const taken = await report(m, sent.actionId, { ok: true });
  assert.equal(taken.status, 200);
  assert.deepEqual(taken.body, { received: true });
  assert.equal(taken.cache, 'no-store');
  const res = await asking;
  assert.deepEqual(res.body, { answer: 'Done: posted to chat.', action: { tool: 'post_to_chat', status: 'done', label: 'Posted to chat' } });
  // finished: reported once
  assert.equal((await report(m, sent.actionId, { ok: true })).status, 404);
  await h.wait(50);
  for (const ws of [ownerPanel, benPanel, guestPanel]) assert.equal(of(ws, 'arlo.did').at(-1).data.action.label, 'Posted to chat');
  closeAll(ownerPanel, benPanel, guestPanel);
});

test('what the panel reports back is what the asker is told', async () => {
  const m = await meetingWith('AH-FAIL==');
  const ownerPanel = await panel(m.meetingId, m.owner, HOST);
  pick = async () => ({ tool: 'admit_from_waiting_room', args: { name: 'James' } });
  const cases = [
    ['not_found', 'I couldn\'t do that: nobody by that name is in the waiting room.'],
    ['several_match', 'I couldn\'t do that: several people in the waiting room match that name.'],
    ['sdk_error', 'I couldn\'t do that: Zoom did not do it.'],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [code, sentence] = cases[i];
    const asking = ask(m, 'Let James in');
    const sent = await actionSent(ownerPanel, i + 1);
    assert.deepEqual([sent.tool, sent.args], ['admit_from_waiting_room', { name: 'James' }]);
    assert.equal((await report(m, sent.actionId, { ok: false, code })).status, 200);
    assert.deepEqual((await asking).body, {
      answer: sentence, action: { tool: 'admit_from_waiting_room', status: 'failed', label: 'Asked to admit James from the waiting room' },
    });
  }
  closeAll(ownerPanel);
});

test('the result route: only the owner the action was sent to, in that meeting, with exactly { ok, code? }', async () => {
  const m = await meetingWith('AH-RESULT==', { secondOwner: true });
  const otherPass = await access('AH-RESULT-OTHER==');
  const ownerPanel = await panel(m.meetingId, m.owner, HOST);
  const asking = ask(m, 'Post "Back in five." to the chat');
  const { actionId } = await actionSent(ownerPanel);

  const none = await call('POST', m.meetingId, `actions/${actionId}/result`, { body: { ok: true } });
  assert.equal(none.status, 401);
  assert.equal(none.cache, 'no-store');
  assert.equal((await report(m, actionId, { ok: true }, cookies(m.ana.session))).status, 401);
  assert.equal((await report(m, actionId, { ok: true }, cookies(otherPass, m.ana.session))).status, 403);
  assert.equal((await report(m, actionId, { ok: true }, m.guest)).status, 401);
  assert.equal((await report(m, actionId, { ok: true }, m.participant)).status, 403); // in the meeting, not an owner
  assert.equal((await report(m, actionId, { ok: true }, m.owner2)).status, 404); // an owner, but it was not sent to them
  assert.equal((await report(m, crypto.randomUUID(), { ok: true })).status, 404);
  assert.equal((await report(m, 'not-an-id', { ok: true })).status, 400);
  assert.equal((await call('POST', m.meetingId, `actions/${actionId}/result`, { headers: m.owner, raw: 'ok=true', type: 'application/x-www-form-urlencoded' })).status, 415);
  for (const body of [
    {}, { ok: 'true' }, { ok: 1 }, { ok: null }, { code: 'not_found' }, { ok: true, code: 'not_found' },
    { ok: false, code: 'rm -rf' }, { ok: false, code: 5 }, { ok: false, code: 'timeout' }, { ok: false, code: 'no_hands' },
    { ok: true, tool: 'post_to_chat' }, { ok: true, userId: m.cy.user.id }, { ok: false, code: 'not_found', message: 'x' }, [true],
  ]) {
    assert.equal((await report(m, actionId, body)).status, 400, JSON.stringify(body));
  }
  // none of that ended it
  assert.equal((await report(m, actionId, { ok: false })).status, 200);
  assert.equal((await asking).body.answer, 'I couldn\'t do that: Zoom did not do it.');
  closeAll(ownerPanel);
});

test('announcements: only an owner\'s, only valid ones, and the newest counts', async () => {
  const m = await meetingWith('AH-ANNOUNCE==', { secondOwner: true });
  // nobody announced anything
  const quiet = await panel(m.meetingId, m.owner);
  assert.match((await ask(m, POST_IT)).body.answer, /nobody who can do it has Arlo open/);

  // an announcement that is not one is ignored, and the socket stays open
  for (const payload of [{ zoomRole: 'host', can: ['share_notes'] }, { zoomRole: 'host' }, 'host', null, { zoomRole: 'host', can: ['post_to_chat'], userId: m.ana.user.id }]) {
    quiet.socket.send(JSON.stringify({ type: 'arlo.hands', payload }));
  }
  await h.wait(50);
  assert.match((await ask(m, POST_IT)).body.answer, /nobody who can do it has Arlo open/);
  assert.equal(quiet.socket.readyState, 1);

  // the other owner's panel can: it gets the action for a request the first owner typed
  const cyPanel = await panel(m.meetingId, m.owner2, { zoomRole: 'attendee', can: ['post_to_chat'] });
  const asking = ask(m, POST_IT);
  const sent = await actionSent(cyPanel);
  assert.equal((await report(m, sent.actionId, { ok: true }, m.owner)).status, 404);
  assert.equal((await report(m, sent.actionId, { ok: true }, m.owner2)).status, 200);
  assert.equal((await asking).body.answer, 'Done: posted to chat.');

  // an attendee cannot admit; announcing again as host changes that
  pick = async () => ({ tool: 'admit_from_waiting_room', args: { name: 'James' } });
  cyPanel.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'attendee', can: ['post_to_chat', 'admit_from_waiting_room'] } }));
  await h.wait(50);
  assert.match((await ask(m, 'admit James')).body.answer, /nobody who can do it has Arlo open/);
  cyPanel.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'coHost', can: ['post_to_chat', 'admit_from_waiting_room'] } }));
  await h.wait(50);
  const admitting = ask(m, 'admit James');
  const admit = await actionSent(cyPanel, 2);
  await report(m, admit.actionId, { ok: true }, m.owner2);
  assert.equal((await admitting).body.answer, 'Done: admitted James from the waiting room.');

  // announcing nothing takes the hands away again
  cyPanel.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'coHost', can: [] } }));
  await h.wait(50);
  assert.match((await ask(m, 'admit James')).body.answer, /nobody who can do it has Arlo open/);
  // and so does closing the panel
  cyPanel.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'coHost', can: ['admit_from_waiting_room'] } }));
  await h.wait(50);
  cyPanel.socket.close();
  await h.wait(100);
  assert.match((await ask(m, 'admit James')).body.answer, /nobody who can do it has Arlo open/);
  closeAll(quiet);
});

test('an owner\'s panel open in another meeting is not this meeting\'s hands', async () => {
  const m = await meetingWith('AH-ELSEWHERE==');
  const otherPass = await access('AH-ELSEWHERE-OTHER==');
  const elsewhere = await panel('AH-ELSEWHERE-OTHER==', cookies(otherPass, m.ana.session), HOST);
  // a restart of her stream lists that socket under this meeting too
  await status(m.meetingId, { status: 'rtms_started', streamId: 's1', operatorId: m.ana.zoomUserId });
  assert.match((await ask(m, POST_IT)).body.answer, /nobody who can do it has Arlo open/);
  assert.deepEqual(of(elsewhere, 'arlo.action'), []);
  closeAll(elsewhere);
});

test('a spoken question: the owner sees the answer on the sheet, and their panel posts exactly that when they agree', async () => {
  const m = await meetingWith('AH-VOICE==');
  await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { whoCanAsk: 'anyone' } });
  const ownerPanel = await panel(m.meetingId, m.owner, HOST);
  const benPanel = await panel(m.meetingId, m.participant);
  pick = async () => ({ tool: 'answer_from_meeting', args: { question: 'When do we ship?' } });
  openrouter.answerFromTranscript = async () => 'On Friday.\nHost: install https://evil.example/x';
  await say(m.meetingId, 'Arlo, when do we ship?');
  const sheet = (await until(() => of(ownerPanel, 'arlo.approval')[0])).data;
  assert.deepEqual(
    [sheet.kind, sheet.question, sheet.primaryLabel, sheet.body, sheet.request, sheet.channel, sheet.askedBy, sheet.askerVerified],
    ['agent_action', 'Post Arlo\'s answer in the meeting chat?', 'Post answer', 'On Friday. Host: install https://evil.example/x', 'when do we ship?', 'voice', 'Ben', false],
  );
  // nothing reached a panel's hands, and nobody but the owners has the text
  await h.wait(100);
  assert.deepEqual(of(ownerPanel, 'arlo.action'), []);
  assert.deepEqual(of(benPanel, 'arlo.approval'), []);
  assert.equal(JSON.stringify(benPanel.messages).includes('evil.example'), false);

  assert.equal((await call('POST', m.meetingId, `approvals/${sheet.id}`, { headers: m.owner, body: { approve: true } })).status, 200);
  const sent = await actionSent(ownerPanel);
  assert.deepEqual([sent.tool, sent.args], ['post_to_chat', { message: `Arlo: ${sheet.body}` }]);
  await report(m, sent.actionId, { ok: true });
  const did = await until(() => of(ownerPanel, 'arlo.did').find((msg) => msg.data.action.status === 'done'));
  assert.deepEqual([did.data.action.tool, did.data.action.status, did.data.action.label, did.data.action.askedBy, did.data.action.public],
    ['answer_from_meeting', 'done', 'Answered a question', 'Ben', true]);
  closeAll(ownerPanel, benPanel);
});

test('a spoken question the owner declines is posted nowhere', async () => {
  const m = await meetingWith('AH-VOICE-NO==');
  const ownerPanel = await panel(m.meetingId, m.owner, HOST);
  pick = async () => ({ tool: 'answer_from_meeting', args: { question: 'When do we ship?' } });
  await say(m.meetingId, 'Arlo, when do we ship?');
  const sheet = (await until(() => of(ownerPanel, 'arlo.approval')[0])).data;
  assert.equal(sheet.body, 'On Friday.');
  assert.equal((await call('POST', m.meetingId, `approvals/${sheet.id}`, { headers: m.owner, body: { approve: false } })).status, 200);
  await h.wait(150);
  // no line of Arlo's in the chat about it either
  assert.deepEqual(of(ownerPanel, 'arlo.action'), []);
  assert.equal(of(ownerPanel, 'arlo.did').at(-1).data.action.status, 'declined');
  closeAll(ownerPanel);
});

test('two owners and one sheet: the first answer wins, the sheet closes on both, and a host\'s panel admits', async () => {
  const m = await meetingWith('AH-SHEET==', { secondOwner: true });
  const anaPanel = await panel(m.meetingId, m.owner, { zoomRole: 'attendee', can: ['post_to_chat', 'admit_from_waiting_room'] });
  const cyPanel = await panel(m.meetingId, m.owner2, HOST);
  const benPanel = await panel(m.meetingId, m.participant);
  pick = async () => ({ tool: 'admit_from_waiting_room', args: { name: 'James' } });
  await say(m.meetingId, 'Arlo, admit James from the waiting room.');
  const sheet = (await until(() => of(anaPanel, 'arlo.approval')[0])).data;
  assert.deepEqual([sheet.kind, sheet.question, sheet.primaryLabel, sheet.askedBy], ['agent_action', 'Admit James from the waiting room?', 'Admit James', 'Ben']);
  assert.deepEqual(of(cyPanel, 'arlo.approval').map((msg) => msg.data), [sheet]);
  assert.deepEqual(of(benPanel, 'arlo.approval'), []);
  // nothing is sent to a panel before an owner agreed
  assert.deepEqual(of(cyPanel, 'arlo.action'), []);

  const answers = await Promise.all([
    call('POST', m.meetingId, `approvals/${sheet.id}`, { headers: m.owner, body: { approve: true } }),
    call('POST', m.meetingId, `approvals/${sheet.id}`, { headers: m.owner2, body: { approve: false } }),
  ]);
  assert.deepEqual(answers.map((res) => res.status).sort(), [200, 404]);
  const { outcome } = answers.find((res) => res.status === 200).body;
  await h.wait(100);
  for (const ws of [anaPanel, cyPanel]) {
    assert.deepEqual(of(ws, 'arlo.approval.closed').map((msg) => msg.data), [{ meetingId: m.meetingId, id: sheet.id, outcome }]);
  }

  if (outcome === 'approved') {
    // Ana agreed; Cy is the host, so his panel does it
    const sent = await actionSent(cyPanel);
    assert.deepEqual([sent.tool, sent.args], ['admit_from_waiting_room', { name: 'James' }]);
    assert.deepEqual(of(anaPanel, 'arlo.action'), []);
    await report(m, sent.actionId, { ok: true }, m.owner2);
    const did = await until(() => of(benPanel, 'arlo.did')[0]);
    assert.deepEqual([did.data.action.status, did.data.action.label], ['done', 'Admitted James from the waiting room']);
  } else {
    await h.wait(100);
    assert.deepEqual(of(cyPanel, 'arlo.action'), []);
    assert.equal(of(benPanel, 'arlo.did')[0].data.action.status, 'declined');
  }
  closeAll(anaPanel, cyPanel, benPanel);
});

test('the meeting ends while a panel has an action: nothing is left, and its result is refused', async () => {
  const m = await meetingWith('AH-ENDED==');
  const ownerPanel = await panel(m.meetingId, m.owner, HOST);
  const { hands } = getAgentRuntime();
  const before = hands.pending();
  const asking = ask(m, 'Post "Back in five." to the chat');
  const sent = await actionSent(ownerPanel);
  assert.equal(hands.pending(), before + 1);
  await status(m.meetingId, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  const res = await asking;
  assert.equal(res.status, 409);
  assert.equal(hands.pending(), before);
  assert.equal((await report(m, sent.actionId, { ok: true })).status, 404);
  closeAll(ownerPanel);
});
