// The agent in the running server: a typed request through POST …/arlo/ask, a
// spoken one through the stored transcript, the owners' approval, and what
// each panel is told. The model calls are replaced: nothing reaches the network.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', AGENT_SPEAKER_MATCH: 'participant_id' });

const test = require('node:test');
const assert = require('node:assert/strict');
const openrouter = require('../src/services/openrouter');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { getMeetingStore } = require('../src/storage');
const { getAgentRuntime } = require('../src/services/agent');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let srv;
const real = { notes: openrouter.generateLiveNotes, ask: openrouter.answerFromTranscript, choose: openrouter.chooseTool };
let pick;
let chosen;
let answer;
test.before(async () => { srv = await h.startServer(); });
let clientIp;
let testNo = 0;
test.beforeEach(() => {
  testNo += 1;
  clientIp = `10.8.0.${testNo}`;
  chosen = [];
  pick = async () => ({ tool: 'answer_from_meeting', args: { question: 'When do we ship?' } });
  answer = async () => 'On Friday.';
  openrouter.generateLiveNotes = async () => ({ summary: 'They ship Friday.', decisions: ['Ship Friday'], actionItems: [] });
  openrouter.answerFromTranscript = async (input) => answer(input);
  openrouter.chooseTool = async (input) => { chosen.push(input); return pick(input); };
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
  const zoomUserId = `zoom-agent-routes-${people}`;
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
    headers: { 'x-forwarded-for': clientIp, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, cache: res.headers.get('cache-control') };
}

/** A meeting Ana (and Cy, when asked) brought Arlo into, with Ben in it signed in. */
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
const panel = async (meetingId, headers) => {
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, headers);
  assert.equal(ws.open, true);
  return ws;
};
const of = (ws, type) => ws.messages.filter((msg) => msg.type === type);
const closeAll = (...panels) => panels.forEach((ws) => ws.socket.close());
const ask = (m, question, headers = m.owner) => call('POST', m.meetingId, 'ask', { headers, body: { question } });
const actions = (m, headers) => call('GET', m.meetingId, 'actions', { headers });
const ACTION_KEYS = ['id', 'at', 'tool', 'label', 'askedBy', 'channel', 'status', 'public'];

test('a typed question is answered as before; the picking model gets the request, the tools and the agent model', async () => {
  const m = await meetingWith('AG-ASK==');
  const res = await ask(m, 'When do we ship?');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { answer: 'On Friday.' });
  assert.equal(res.cache, 'no-store');
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].request, 'When do we ship?');
  // nothing of the meeting goes to the model that picks: no transcript, no notes
  assert.deepEqual(Object.keys(chosen[0]).filter((key) => key !== 'signal').sort(), ['model', 'request', 'tools']);
  assert.equal(JSON.stringify(chosen[0]).includes('Friday'), false);
  // and it can be stopped: when the request's time is up, or the meeting's data goes
  assert.ok(chosen[0].signal instanceof AbortSignal);
  assert.deepEqual(chosen[0].tools.map((tool) => tool.name), ['answer_from_meeting', 'summarize_so_far', 'post_to_chat', 'admit_from_waiting_room', 'share_notes', 'invite_everyone', 'open_notes_for_everyone', 'send_reaction', 'mute_participant', 'set_timer', 'stop_timer']);
  assert.equal(typeof chosen[0].model, 'string');

  // recorded as the owner's own, private action
  const mine = await actions(m, m.owner);
  assert.equal(mine.body.actions.length, 1);
  assert.deepEqual(Object.keys(mine.body.actions[0]), ACTION_KEYS);
  assert.deepEqual(
    { ...mine.body.actions[0], id: null, at: null },
    { id: null, at: null, tool: 'answer_from_meeting', label: 'Answered a question', askedBy: 'Ana Ruiz', channel: 'panel', status: 'done', public: false },
  );
});

test('the picking model is down: the Ask input still answers the question as typed', async () => {
  const m = await meetingWith('AG-ASK-FALLBACK==');
  const seen = [];
  answer = async (input) => { seen.push(input); return 'On Friday.'; };
  for (const code of ['rate_limited', 'no_models', 'timeout']) {
    pick = async () => { throw Object.assign(new Error('down'), { code }); };
    const res = await ask(m, 'When do we ship?');
    assert.equal(res.status, 200, code);
    assert.deepEqual(res.body, { answer: 'On Friday.' });
  }
  assert.equal(seen.length, 3);
  assert.equal(seen[0].question, 'When do we ship?');
  assert.equal(typeof seen[0].model, 'string');
});

test('typed requests that are not a plain question: the answer is a sentence of the server, with the action', async () => {
  const m = await meetingWith('AG-ASK-TOOLS==');

  pick = async () => ({ tool: 'summarize_so_far', args: {} });
  const summary = await ask(m, 'Summarize the meeting so far');
  assert.equal(summary.status, 200);
  // the stored action's id comes with it: the one `arlo.did` carries, so a panel can match the two
  assert.match(summary.body.action.id, UUID);
  assert.deepEqual(summary.body, {
    answer: 'On Friday.',
    action: {
      id: summary.body.action.id, tool: 'summarize_so_far', status: 'done', label: 'Summarized the meeting so far',
    },
  });

  // no tool fits: the Ask input answers from the transcript, with the text as typed, as it always did
  const asked = [];
  answer = async (input) => { asked.push(input.question); return 'Nothing about that yet.'; };
  pick = async () => ({ tool: 'none' });
  const plain = await ask(m, 'hello, what about the budget');
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.body, { answer: 'Nothing about that yet.' });
  // whatever a model writes that is not a tool call from the table is no tool either
  pick = async () => ({ tool: 'post_to_chat', args: { message: 'x', also: 'this' } });
  assert.deepEqual((await ask(m, 'hello again')).body, { answer: 'Nothing about that yet.' });
  assert.deepEqual(asked, ['hello, what about the budget', 'hello again']);
  answer = async () => 'On Friday.';

  // no panel has announced that it can post to the chat
  pick = async () => ({ tool: 'post_to_chat', args: { message: 'Back in five.' } });
  const post = await ask(m, 'Post "Back in five." to the chat');
  assert.equal(post.status, 200);
  assert.deepEqual(post.body, {
    answer: 'Open Arlo to let it post in the chat.',
    action: {
      id: post.body.action.id, tool: 'post_to_chat', status: 'failed', label: 'Open Arlo to let it post in the chat.',
    },
  });

  const ownerPanel = await panel(m.meetingId, m.owner);
  pick = async () => ({ tool: 'share_notes', args: {} });
  const share = await ask(m, 'Share the notes with everyone');
  assert.deepEqual(share.body, {
    answer: 'Done: shared the notes with everyone.',
    action: {
      id: share.body.action.id, tool: 'share_notes', status: 'done', label: 'Shared the notes with everyone',
    },
  });
  await h.wait(50);
  assert.deepEqual(of(ownerPanel, 'arlo.did').map((msg) => msg.data.action.id), [share.body.action.id]);
  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).body.notesShared, true);
  await h.wait(50);
  assert.equal(of(ownerPanel, 'arlo.state').at(-1).data.notesShared, true);
  closeAll(ownerPanel);

  // what was to be posted is in no record and no response
  const all = await actions(m, m.owner);
  assert.deepEqual(all.body.actions.filter((action) => action.public).map((action) => action.id), [post.body.action.id, share.body.action.id]);
  assert.equal(JSON.stringify(all.body).includes('Back in five'), false);
  assert.deepEqual(all.body.actions.map((action) => [action.tool, action.status, action.public]), [
    ['summarize_so_far', 'done', false], ['answer_from_meeting', 'done', false], ['answer_from_meeting', 'done', false],
    ['post_to_chat', 'failed', true], ['share_notes', 'done', true],
  ]);
});

test('the answering model fails: the same errors as before, and no words of the model', async () => {
  const m = await meetingWith('AG-ASK-ERRORS==');
  answer = async () => { throw Object.assign(new Error('rate limited'), { code: 'rate_limited' }); };
  const limited = await ask(m, 'When do we ship?');
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /rate limited/);
  answer = async () => { throw new Error('upstream 401: key sk-secret, transcript: We ship on Friday.'); };
  const failed = await ask(m, 'When do we ship?');
  assert.equal(failed.status, 502);
  assert.equal(/sk-secret|Friday/.test(JSON.stringify(failed.body)), false);
});

test('thinking for a typed request goes on and off on the asker\'s own panel only; a private answer is told to the asker alone', async () => {
  const m = await meetingWith('AG-THINKING==', { secondOwner: true });
  const [anaPanel, cyPanel, benPanel, guestPanel] = await Promise.all([
    panel(m.meetingId, m.owner), panel(m.meetingId, m.owner2), panel(m.meetingId, m.participant), panel(m.meetingId, m.guest),
  ]);
  await h.wait(50);
  await ask(m, 'When do we ship?');
  await h.wait(100);

  // with "on": what Arlo is doing and how it was asked; "off" carries neither
  const thinking = (channel, ...steps) => [
    ...steps.map((step) => ({ type: 'arlo.thinking', data: { meetingId: m.meetingId, on: true, step, channel } })),
    { type: 'arlo.thinking', data: { meetingId: m.meetingId, on: false } },
  ];
  const typedQuestion = thinking('panel', 'Working out what was asked', 'Writing an answer');
  assert.deepEqual(of(anaPanel, 'arlo.thinking'), typedQuestion);
  // the other owner is not told that she asked something in private
  for (const ws of [cyPanel, benPanel, guestPanel]) assert.deepEqual(of(ws, 'arlo.thinking'), []);

  const did = of(anaPanel, 'arlo.did');
  assert.equal(did.length, 1);
  assert.deepEqual(Object.keys(did[0].data), ['meetingId', 'action']);
  assert.deepEqual(Object.keys(did[0].data.action), ACTION_KEYS);
  assert.deepEqual([did[0].data.meetingId, did[0].data.action.status, did[0].data.action.public], [m.meetingId, 'done', false]);
  for (const ws of [cyPanel, benPanel, guestPanel]) assert.deepEqual(of(ws, 'arlo.did'), []);

  // a participant's typed question, where anyone may ask: no owner's panel shows Arlo thinking
  await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { whoCanAsk: 'anyone' } });
  assert.equal((await ask(m, 'When do we ship?', m.participant)).status, 200);
  await h.wait(100);
  assert.deepEqual(of(anaPanel, 'arlo.thinking'), typedQuestion);
  for (const ws of [cyPanel, benPanel, guestPanel]) assert.deepEqual(of(ws, 'arlo.thinking'), []);
  // something said in the meeting is heard by everyone: both owners' panels show it
  pick = async () => ({ tool: 'share_notes', args: {} });
  await say(m.meetingId, 'Arlo, share the notes with everyone.');
  await h.wait(150);
  const spoken = thinking('voice', 'Heard a request', 'Working out what was asked');
  assert.deepEqual(of(anaPanel, 'arlo.thinking').slice(3), spoken);
  assert.deepEqual(of(cyPanel, 'arlo.thinking'), spoken);
  for (const ws of [benPanel, guestPanel]) assert.deepEqual(of(ws, 'arlo.thinking'), []);
  closeAll(anaPanel, cyPanel, benPanel, guestPanel);
});

test('GET actions: owners see their own private ones, everyone else in the meeting the public ones; nothing is cached', async () => {
  const m = await meetingWith('AG-ACTIONS==', { secondOwner: true });
  const otherPass = await access('AG-ACTIONS-OTHER==');
  await ask(m, 'When do we ship?', m.owner);
  await ask(m, 'When do we ship?', m.owner2);
  pick = async () => ({ tool: 'share_notes', args: {} });
  await ask(m, 'Share the notes', m.owner);

  const none = await call('GET', m.meetingId, 'actions');
  assert.equal(none.status, 401);
  assert.equal(none.cache, 'no-store');
  assert.equal((await actions(m, cookies(m.ana.session))).status, 401);
  assert.equal((await actions(m, cookies(otherPass, m.ana.session))).status, 403);
  assert.equal((await actions(m, cookies('meetingAccess=not.a.token', m.ana.session))).status, 401);

  const summary = (res) => res.body.actions.map((action) => [action.tool, action.askedBy, action.public]);
  const ana = await actions(m, m.owner);
  assert.equal(ana.status, 200);
  assert.equal(ana.cache, 'no-store');
  assert.deepEqual(summary(ana), [['answer_from_meeting', 'Ana Ruiz', false], ['share_notes', 'Ana Ruiz', true]]);
  assert.deepEqual(summary(await actions(m, m.owner2)), [['answer_from_meeting', 'Cy Young', false], ['share_notes', 'Ana Ruiz', true]]);
  for (const headers of [m.participant, m.guest, cookies(m.pass, 'sessionToken=forged.token.value')]) {
    const res = await actions(m, headers);
    assert.equal(res.status, 200);
    assert.deepEqual(summary(res), [['share_notes', 'Ana Ruiz', true]]);
  }
});

test('spoken by someone not verified: the owners get the sheet, and agreeing does it', async () => {
  const m = await meetingWith('AG-VOICE-SHEET==', { secondOwner: true });
  const [anaPanel, cyPanel, benPanel, guestPanel] = await Promise.all([
    panel(m.meetingId, m.owner), panel(m.meetingId, m.owner2), panel(m.meetingId, m.participant), panel(m.meetingId, m.guest),
  ]);
  await h.wait(50);
  pick = async () => ({ tool: 'share_notes', args: {} });
  const before = Date.now();
  await say(m.meetingId, 'Arlo, share the notes with everyone.');
  await h.wait(150);

  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].request, 'share the notes with everyone.');
  const sheets = of(anaPanel, 'arlo.approval');
  assert.equal(sheets.length, 1);
  const { data } = sheets[0];
  assert.match(data.id, UUID);
  assert.ok(data.expiresAt >= before + 60000 && data.expiresAt <= Date.now() + 60000);
  assert.deepEqual(data, {
    meetingId: m.meetingId,
    id: data.id,
    kind: 'agent_action',
    askedBy: 'Ben',
    askerVerified: false,
    expiresAt: data.expiresAt,
    expiresInMs: data.expiresInMs,
    question: 'Share the notes with everyone in the meeting?',
    primaryLabel: 'Share notes',
    channel: 'voice',
    request: 'share the notes with everyone.',
  });
  assert.deepEqual(of(cyPanel, 'arlo.approval'), sheets);
  for (const ws of [benPanel, guestPanel]) assert.deepEqual(of(ws, 'arlo.approval'), []);
  // a panel that reloads still finds it
  const listed = (await call('GET', m.meetingId, 'approvals', { headers: m.owner2 })).body;
  // the same sheet, with the time left when the list was read
  assert.ok(Number.isInteger(listed.approvals[0].expiresInMs) && listed.approvals[0].expiresInMs <= data.expiresInMs);
  assert.deepEqual(listed, { approvals: [{ ...data, expiresInMs: listed.approvals[0].expiresInMs }] });
  // waiting, and everyone in the meeting can see that it was asked
  const waiting = (await actions(m, m.guest)).body.actions;
  assert.deepEqual(waiting.map((action) => [action.tool, action.status, action.label, action.askedBy, action.channel]),
    [['share_notes', 'waiting_approval', 'Asked to share the notes with everyone', 'Ben', 'voice']]);
  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).body.notesShared, false);

  // someone who is not an owner cannot answer it
  assert.equal((await call('POST', m.meetingId, `approvals/${data.id}`, { headers: m.participant, body: { approve: true } })).status, 403);
  const agreed = await call('POST', m.meetingId, `approvals/${data.id}`, { headers: m.owner2, body: { approve: true } });
  assert.equal(agreed.status, 200);
  assert.deepEqual(agreed.body, { id: data.id, outcome: 'approved' });
  // the other owner is too late
  assert.equal((await call('POST', m.meetingId, `approvals/${data.id}`, { headers: m.owner, body: { approve: false } })).status, 404);
  await h.wait(150);

  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).body.notesShared, true);
  for (const ws of [anaPanel, cyPanel]) {
    assert.deepEqual(of(ws, 'arlo.approval.closed'), [{ type: 'arlo.approval.closed', data: { meetingId: m.meetingId, id: data.id, outcome: 'approved' } }]);
  }
  for (const ws of [benPanel, guestPanel]) assert.deepEqual(of(ws, 'arlo.approval.closed'), []);
  // done, and told to every panel in the meeting
  for (const ws of [anaPanel, cyPanel, benPanel, guestPanel]) {
    const did = of(ws, 'arlo.did');
    assert.equal(did.length, 1);
    assert.deepEqual([did[0].data.action.id, did[0].data.action.status, did[0].data.action.label, did[0].data.action.public],
      [waiting[0].id, 'done', 'Shared the notes with everyone', true]);
  }
  assert.equal(of(anaPanel, 'arlo.thinking').at(-1).data.on, false);
  closeAll(anaPanel, cyPanel, benPanel, guestPanel);
});

test('"not now" ends a spoken request, and a request for the notes keeps working beside it', async () => {
  const m = await meetingWith('AG-VOICE-DECLINE==');
  const ownerPanel = await panel(m.meetingId, m.owner);
  await h.wait(50);
  pick = async () => ({ tool: 'post_to_chat', args: { message: 'Lunch is here.' } });
  await say(m.meetingId, 'Hey Arlo, post lunch is here to the chat.');
  await h.wait(150);
  const notesRequest = await call('POST', m.meetingId, 'notes-request', { headers: m.participant, body: {} });
  assert.equal(notesRequest.status, 200);
  await h.wait(50);

  const sheets = of(ownerPanel, 'arlo.approval').map((msg) => msg.data);
  assert.deepEqual(sheets.map((data) => data.kind), ['agent_action', 'share_notes']);
  assert.deepEqual([sheets[0].question, sheets[0].body, sheets[0].primaryLabel], ['Post this in the meeting chat?', 'Lunch is here.', 'Post to chat']);
  assert.deepEqual(Object.keys(sheets[1]), ['meetingId', 'id', 'kind', 'askedBy', 'expiresAt', 'expiresInMs']);

  const declined = await call('POST', m.meetingId, `approvals/${sheets[0].id}`, { headers: m.owner, body: { approve: false } });
  assert.deepEqual(declined.body, { id: sheets[0].id, outcome: 'declined' });
  await h.wait(100);
  assert.deepEqual((await actions(m, m.guest)).body.actions.map((action) => [action.status, action.label]),
    [['declined', 'Asked to post to chat']]);
  assert.equal(of(ownerPanel, 'arlo.did').at(-1).data.action.status, 'declined');
  // the request for the notes is still open, and agreeing to it shares them as before
  const shared = await call('POST', m.meetingId, `approvals/${sheets[1].id}`, { headers: m.owner, body: { approve: true } });
  assert.deepEqual(shared.body, { id: sheets[1].id, outcome: 'approved' });
  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).body.notesShared, true);
  closeAll(ownerPanel);
});

test('AGENT_SPEAKER_MATCH=participant_id: a speaker whose id an owner\'s panel reported is verified on the sheet, and still gets the sheet', async () => {
  const m = await meetingWith('AG-VOICE-VERIFIED==');
  const ownerPanel = await panel(m.meetingId, m.owner);
  assert.equal((await call('POST', m.meetingId, 'identity', { headers: m.owner, body: { participantId: '7', screenName: 'Ana Ruiz' } })).status, 200);
  pick = async () => ({ tool: 'share_notes', args: {} });

  // the same name, another id: not her
  await say(m.meetingId, 'Arlo, share the notes with everyone.', { speakerId: '9', speakerLabel: 'Ana Ruiz' });
  await h.wait(150);
  assert.equal(of(ownerPanel, 'arlo.approval').length, 1);
  assert.deepEqual([of(ownerPanel, 'arlo.approval')[0].data.askedBy, of(ownerPanel, 'arlo.approval')[0].data.askerVerified], ['Ana Ruiz', false]);
  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).body.notesShared, false);

  // her id, whatever the name: the sheet says the server knows who spoke. Nothing is done before the button
  await say(m.meetingId, 'Arlo, share the notes with everybody now.', { speakerId: '7', speakerLabel: 'Renamed' });
  await h.wait(150);
  const sheets = of(ownerPanel, 'arlo.approval');
  assert.equal(sheets.length, 2);
  assert.deepEqual([sheets[1].data.askedBy, sheets[1].data.askerVerified], ['Renamed', true]);
  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).body.notesShared, false);
  assert.equal((await call('POST', m.meetingId, `approvals/${sheets[1].data.id}`, { headers: m.owner, body: { approve: true } })).status, 200);
  await h.wait(100);
  assert.equal((await call('GET', m.meetingId, 'state', { headers: m.guest })).body.notesShared, true);
  closeAll(ownerPanel);
});

test('talk about Arlo, and a wake word no tool fits, do nothing anyone sees', async () => {
  const m = await meetingWith('AG-VOICE-SILENT==');
  const ownerPanel = await panel(m.meetingId, m.owner);
  await say(m.meetingId, 'I asked Arlo about this yesterday.');
  await say(m.meetingId, 'Arlo is taking notes for us.');
  await h.wait(100);
  assert.equal(chosen.length, 0);
  pick = async () => ({ tool: 'none' });
  await say(m.meetingId, 'Arlo, you are great today.');
  await h.wait(150);
  assert.equal(chosen.length, 1);
  assert.deepEqual((await actions(m, m.owner)).body.actions, []);
  assert.deepEqual(of(ownerPanel, 'arlo.approval'), []);
  assert.deepEqual(of(ownerPanel, 'arlo.did'), []);
  closeAll(ownerPanel);
});

test('when the meeting ends nothing of the agent is left, and a model that answers late changes nothing', async () => {
  const m = await meetingWith('AG-ENDED==');
  const ownerPanel = await panel(m.meetingId, m.owner);
  await ask(m, 'When do we ship?');
  pick = async () => ({ tool: 'share_notes', args: {} });
  await say(m.meetingId, 'Arlo, share the notes with everyone.');
  await h.wait(150);
  const sheet = of(ownerPanel, 'arlo.approval')[0].data;
  assert.equal((await actions(m, m.owner)).body.actions.length, 2);
  assert.equal(getAgentRuntime().agent.holds(m.meetingId), true);

  // a typed question is with the model when the meeting ends
  let release;
  let answering;
  pick = async () => ({ tool: 'answer_from_meeting', args: { question: 'When do we ship?' } });
  answer = (input) => { answering = input.signal; return new Promise((resolve) => { release = resolve; }); };
  const late = ask(m, 'When do we ship?');
  await h.wait(100);
  assert.equal(of(ownerPanel, 'arlo.thinking').at(-1).data.on, true);
  await status(m.meetingId, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  await h.wait(50);
  // the panel is told thinking stopped
  assert.equal(of(ownerPanel, 'arlo.thinking').at(-1).data.on, false);
  // and the model call that was running for this meeting is stopped
  assert.equal(answering.aborted, true);
  const told = ownerPanel.messages.length;
  release('On Friday.');
  const res = await late;
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'no_transcript');

  const { agent } = getAgentRuntime();
  assert.equal(agent.holds(m.meetingId), false);
  assert.deepEqual(getMeetingStore().listActions(m.meetingId), []);
  assert.deepEqual((await actions(m, m.owner)).body, { actions: [] });
  assert.equal((await call('POST', m.meetingId, `approvals/${sheet.id}`, { headers: m.owner, body: { approve: true } })).status, 404);
  await h.wait(50);
  assert.equal(ownerPanel.messages.filter((msg) => msg.type.startsWith('arlo.did') || msg.type === 'arlo.thinking').length,
    ownerPanel.messages.slice(0, told).filter((msg) => msg.type.startsWith('arlo.did') || msg.type === 'arlo.thinking').length);
  closeAll(ownerPanel);
});

test('a spoken request reaches a model only while an owner has a panel open in the meeting', async () => {
  const m = await meetingWith('AG-VOICE-NOBODY==');
  // nobody has Arlo open
  await say(m.meetingId, 'Arlo, when do we ship?');
  await h.wait(150);
  assert.equal(chosen.length, 0);
  // a participant and a guest have, and the notes are shared with them: still no owner to deliver or approve
  assert.equal((await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { shareNotes: true, whoCanAsk: 'anyone' } })).status, 200);
  const [benPanel, guestPanel] = await Promise.all([panel(m.meetingId, m.participant), panel(m.meetingId, m.guest)]);
  await say(m.meetingId, 'Arlo, when do we ship now?');
  await h.wait(150);
  assert.equal(chosen.length, 0);
  assert.deepEqual((await actions(m, m.owner)).body.actions, []);
  // a typed question does not need a panel on a socket
  assert.equal((await ask(m, 'When do we ship?')).status, 200);
  assert.equal(chosen.length, 1);
  // an owner opens Arlo: heard
  const ownerPanel = await panel(m.meetingId, m.owner);
  await say(m.meetingId, 'Arlo, when do we really ship?');
  await h.wait(150);
  assert.equal(chosen.length, 2);
  closeAll(benPanel, guestPanel, ownerPanel);
});

test('sendArloThinking sends a step and a channel only as what they are, and never with "off"', async () => {
  const { sendArloThinking } = require('../src/services/websocket');
  const m = await meetingWith('AG-THINKING-STEP==');
  const ownerPanel = await panel(m.meetingId, m.owner);
  await h.wait(50);
  const owners = [m.ana.user.id];
  const before = of(ownerPanel, 'arlo.thinking').length;
  sendArloThinking(m.meetingId, owners, true, { step: 'Writing an answer', channel: 'voice' });
  sendArloThinking(m.meetingId, owners, true, { step: 'x'.repeat(121), channel: 'radio' });
  sendArloThinking(m.meetingId, owners, true, { step: 'Line one\nline two', channel: 'panel' });
  sendArloThinking(m.meetingId, owners, true, { step: { toString: () => 'no' }, channel: ['voice'] });
  sendArloThinking(m.meetingId, owners, true, null);
  sendArloThinking(m.meetingId, owners, true);
  sendArloThinking(m.meetingId, owners, false, { step: 'Writing an answer', channel: 'voice' });
  await h.wait(100);
  assert.deepEqual(of(ownerPanel, 'arlo.thinking').slice(before).map((msg) => msg.data), [
    { meetingId: m.meetingId, on: true, step: 'Writing an answer', channel: 'voice' },
    { meetingId: m.meetingId, on: true },
    { meetingId: m.meetingId, on: true, channel: 'panel' },
    { meetingId: m.meetingId, on: true },
    { meetingId: m.meetingId, on: true },
    { meetingId: m.meetingId, on: true },
    { meetingId: m.meetingId, on: false },
  ]);
  closeAll(ownerPanel);
});
