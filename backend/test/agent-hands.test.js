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
const POST = { tool: 'post_to_chat', args: { message: 'Back in five.' }, userId: 'user-ana' };
const ADMIT = { tool: 'admit_from_waiting_room', args: { name: 'James' }, userId: 'user-ana' };
const turn = () => new Promise((resolve) => { setImmediate(resolve); });
/** What a run resolved to, or 'waiting' when it has not: a test never waits on a run that may not settle. */
const settled = (running) => Promise.race([running, turn().then(turn).then(() => 'waiting')]);

test('an action goes to one panel, and its result is the outcome', async () => {
  const s = setup();
  const ana = s.panel('user-ana', 'host', ['post_to_chat']);
  const running = s.hands.run(M, POST);
  assert.equal(ana.got.length, 1);
  const { type, data } = ana.got[0];
  assert.equal(type, 'arlo.action');
  assert.match(data.actionId, UUID);
  // who it is for is not in the message: the panel is theirs
  assert.deepEqual(data, { meetingId: M, actionId: data.actionId, tool: 'post_to_chat', args: { message: 'Back in five.' } });
  assert.equal(s.hands.pending(), 1);

  assert.equal(s.hands.result(M, data.actionId, 'user-ana', { ok: true }), true);
  assert.deepEqual(await running, { ok: true });
  assert.equal(s.hands.pending(), 0);
  assert.equal(s.live(), 0);

  // every code a panel may report is passed on; anything else is "the SDK failed"
  assert.deepEqual([...RESULT_CODES], ['not_found', 'several_match', 'no_notes', 'sdk_error', 'unsupported', 'not_allowed', 'share_failed']);
  for (const [code, expected] of [...RESULT_CODES].map((one) => [one, one]).concat([[undefined, 'sdk_error'], ['rm -rf', 'sdk_error'], [5, 'sdk_error']])) {
    const again = s.hands.run(M, POST);
    s.hands.result(M, ana.got.at(-1).data.actionId, 'user-ana', { ok: false, code });
    assert.deepEqual(await again, { ok: false, code: expected });
  }
});

test('whose panel: only the owner who typed or approved it, never another owner\'s, host or not', async () => {
  const s = setup();
  const guest = s.panel(null, 'host', ['post_to_chat'], 1);
  const ben = s.panel('user-ben', 'host', ['post_to_chat'], 2); // signed in, not an owner
  const cannot = s.panel('user-ana', 'host', ['admit_from_waiting_room'], 3); // hers, but did not announce posting
  const cyHost = s.panel('user-cy', 'host', ['post_to_chat', 'admit_from_waiting_room'], 4); // the host, and another owner
  const later = s.panel('user-ana', 'attendee', ['post_to_chat'], 6);
  const first = s.panel('user-ana', 'attendee', ['post_to_chat'], 5);

  // Ana's request: her own panel, the one connected longest. Not the host's
  s.hands.run(M, POST);
  assert.equal(first.got.length, 1);
  for (const other of [guest, ben, cannot, cyHost, later]) assert.equal(other.got.length, 0);

  // she has no panel that can post: it fails. Cy's panel, which could, is not used
  s.t.panels.splice(s.t.panels.indexOf(first), 1);
  s.t.panels.splice(s.t.panels.indexOf(later), 1);
  assert.deepEqual(await settled(s.hands.run(M, POST)), { ok: false, code: 'no_hands' });
  assert.equal(cyHost.got.length, 0);
  // Cy's own request does run on Cy's panel
  s.hands.run(M, { ...POST, userId: 'user-cy' });
  assert.equal(cyHost.got.length, 1);

  // nobody behind the action, or someone who is not an owner: no panel at all
  for (const userId of [undefined, null, '', 5, 'user-ben', 'x'.repeat(257), ['user-cy']]) {
    assert.deepEqual(await settled(s.hands.run(M, { ...POST, userId })), { ok: false, code: 'no_hands' }, String(userId));
  }
  assert.equal(ben.got.length + guest.got.length, 0);
  assert.equal(cyHost.got.length, 1);

  // someone stops being an owner: their panel is not used, whatever it announced
  s.t.owners = ['user-ana'];
  assert.deepEqual(await settled(s.hands.run(M, { ...POST, userId: 'user-cy' })), { ok: false, code: 'no_hands' });
  assert.equal(cyHost.got.length, 1);
});

test('admitting from the waiting room needs a host\'s or co-host\'s panel, and the owner\'s own', async () => {
  const s = setup();
  const attendee = s.panel('user-ana', 'attendee', ['admit_from_waiting_room', 'post_to_chat'], 1);
  const cyHost = s.panel('user-cy', 'host', ['admit_from_waiting_room'], 2);
  // an attendee's panel cannot admit, and nothing is sent to it. Settles at once: nothing waits for a result
  for (const zoomRole of ['attendee', 'panelist', 'owner', '']) {
    attendee.zoomRole = zoomRole;
    assert.deepEqual(await settled(s.hands.run(M, ADMIT)), { ok: false, code: 'no_hands' }, zoomRole);
  }
  assert.equal(attendee.got.length, 0);
  assert.equal(s.hands.pending(), 0);
  // the host is another owner: not used for her request
  assert.equal(cyHost.got.length, 0);
  // the same panel may still post
  assert.equal(await settled(s.hands.run(M, POST)), 'waiting');
  assert.equal(attendee.got.length, 1);

  for (const zoomRole of ['host', 'coHost']) {
    attendee.zoomRole = zoomRole;
    s.hands.run(M, ADMIT);
    assert.deepEqual(attendee.got.at(-1).data.args, { name: 'James' }, zoomRole);
  }
  assert.equal(attendee.got.length, 3);
});

test('muting needs a host\'s or co-host\'s panel like admitting; inviting and reacting run on any panel of the owner', async () => {
  const s = setup();
  const MUTE = { tool: 'mute_participant', args: { name: 'Danny' }, userId: 'user-ana' };
  const attendee = s.panel('user-ana', 'attendee', ['mute_participant', 'invite_everyone', 'send_reaction'], 1);
  s.panel('user-cy', 'host', ['mute_participant'], 2);
  // her panel is an attendee's, and another owner's host panel is never used
  assert.deepEqual(await settled(s.hands.run(M, MUTE)), { ok: false, code: 'no_hands' });
  assert.deepEqual(s.hands.whoCan(M, 'mute_participant'), ['user-cy']);
  assert.deepEqual(s.hands.whoCan(M, 'invite_everyone'), ['user-ana']);
  assert.deepEqual(s.hands.whoCan(M, 'send_reaction'), ['user-ana']);

  for (const call of [{ tool: 'invite_everyone', args: {} }, { tool: 'send_reaction', args: { reaction: 'clap' } }]) {
    const running = s.hands.run(M, { ...call, userId: 'user-ana' });
    const sent = attendee.got.at(-1);
    assert.deepEqual([sent.type, sent.data.tool, sent.data.args], ['arlo.action', call.tool, call.args]);
    assert.equal(s.hands.result(M, sent.data.actionId, 'user-ana', { ok: true }), true);
    assert.deepEqual(await running, { ok: true });
  }

  const coHost = s.panel('user-ana', 'coHost', ['mute_participant'], 3);
  const muting = s.hands.run(M, MUTE);
  assert.deepEqual([coHost.got.at(-1).data.tool, coHost.got.at(-1).data.args], ['mute_participant', { name: 'Danny' }]);
  assert.equal(s.hands.result(M, coHost.got.at(-1).data.actionId, 'user-ana', { ok: false, code: 'not_found' }), true);
  assert.deepEqual(await muting, { ok: false, code: 'not_found' });
});

test('who can: the owners with a panel open that may run the tool', () => {
  const s = setup();
  s.panel('user-ana', 'attendee', ['post_to_chat', 'admit_from_waiting_room'], 1);
  s.panel('user-ana', 'attendee', ['post_to_chat'], 2);
  s.panel('user-cy', 'coHost', ['admit_from_waiting_room'], 3);
  s.panel('user-ben', 'host', ['post_to_chat', 'admit_from_waiting_room'], 4); // not an owner
  s.panel(null, 'host', ['post_to_chat', 'admit_from_waiting_room'], 5);
  assert.deepEqual(s.hands.whoCan(M, 'post_to_chat'), ['user-ana']);
  assert.deepEqual(s.hands.whoCan(M, 'admit_from_waiting_room'), ['user-cy']);
  for (const [meetingId, tool] of [['ANOTHER==', 'post_to_chat'], [M, 'share_notes'], [M, 'delete_everything'], [M, null], ['', 'post_to_chat'], [null, 'post_to_chat']]) {
    assert.deepEqual(s.hands.whoCan(meetingId, tool), []);
  }
  s.t.owners = [];
  assert.deepEqual(s.hands.whoCan(M, 'post_to_chat'), []);
  // panels that cannot be listed: nobody
  const broken = createHands({ panels: () => { throw new Error('down'); }, isOwner: () => true });
  assert.deepEqual(broken.whoCan(M, 'post_to_chat'), []);
});

test('no panel, a tool that is not a panel\'s, or a call that is not one: nothing is sent', async () => {
  const s = setup();
  assert.deepEqual(await s.hands.run(M, POST), { ok: false, code: 'no_hands' });
  const ana = s.panel('user-ana', 'host', ['post_to_chat', 'share_notes', 'answer_from_meeting']);
  assert.deepEqual(await s.hands.run('ANOTHER==', POST), { ok: false, code: 'no_hands' });
  for (const call of [
    { tool: 'share_notes', args: {}, userId: 'user-ana' }, { tool: 'answer_from_meeting', args: { question: 'x' }, userId: 'user-ana' },
    { tool: 'delete_everything', args: {}, userId: 'user-ana' },
    { tool: 'post_to_chat', userId: 'user-ana' }, { tool: 'post_to_chat', args: 'hello', userId: 'user-ana' }, { tool: 5, args: {}, userId: 'user-ana' },
    null, undefined, 'post_to_chat',
  ]) {
    assert.deepEqual(await s.hands.run(M, call), { ok: false, code: 'unsupported' }, JSON.stringify(call));
  }
  for (const meetingId of ['', null, 5]) assert.deepEqual(await s.hands.run(meetingId, POST), { ok: false, code: 'no_hands' });
  assert.equal(ana.got.length, 0);
  assert.equal(s.hands.pending(), 0);
});

test('a panel that cannot be sent to is passed over, for another panel of the same owner', async () => {
  const s = setup();
  const broken = s.panel('user-ana', 'host', ['post_to_chat'], 1, false);
  const thrower = s.panel('user-ana', 'host', ['post_to_chat'], 2);
  thrower.send = () => { throw new Error('socket closed'); };
  const cy = s.panel('user-cy', 'host', ['post_to_chat'], 3);
  const works = s.panel('user-ana', 'attendee', ['post_to_chat'], 4);
  const running = s.hands.run(M, POST);
  assert.equal(broken.got.length, 1);
  assert.equal(works.got.length, 1);
  assert.equal(cy.got.length, 0);
  // only the user it was sent to may answer
  assert.equal(s.hands.result(M, works.got[0].data.actionId, 'user-cy', { ok: true }), false);
  assert.equal(s.hands.result(M, works.got[0].data.actionId, 'user-ana', { ok: true }), true);
  assert.deepEqual(await running, { ok: true });

  // none of her panels can be sent to: it ends, and Cy's panel is still not used
  s.t.panels.pop();
  assert.deepEqual(await settled(s.hands.run(M, POST)), { ok: false, code: 'no_hands' });
  assert.equal(cy.got.length, 0);
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
  // finished: another verdict changes nothing and is refused
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: true }), false);

  // someone who stopped being an owner cannot report any more
  const next = s.hands.run(M, POST);
  s.t.owners = ['user-cy'];
  assert.equal(s.hands.result(M, ana.got[1].data.actionId, 'user-ana', { ok: true }), false);
  s.advance(15000);
  assert.deepEqual(await next, { ok: false, code: 'timeout' });
});

test('a result for the same action reported in another meeting is refused, also by someone who is an owner there too', async () => {
  // Ana is an owner of both meetings, and has a panel in each
  const OTHER = 'MEETING-HANDS-OTHER==';
  const panels = { [M]: [], [OTHER]: [] };
  const hands = createHands({ panels: (meetingId) => panels[meetingId] || [], isOwner: (meetingId, userId) => userId === 'user-ana' });
  const got = [];
  for (const meetingId of [M, OTHER]) {
    panels[meetingId].push({
      userId: 'user-ana', zoomRole: 'host', can: ['post_to_chat'], since: 1, send(message) { got.push(message); return true; },
    });
  }
  const running = hands.run(M, POST);
  const { actionId } = got[0].data;
  assert.equal(got[0].data.meetingId, M);
  // the right user, the right action, an owner of the meeting named: but not the meeting it was sent in
  assert.equal(hands.result(OTHER, actionId, 'user-ana', { ok: true }), false);
  assert.equal(await settled(running), 'waiting');
  assert.equal(hands.pending(), 1);
  assert.equal(hands.result(M, actionId, 'user-ana', { ok: true }), true);
  assert.deepEqual(await running, { ok: true });
  // and a repeat is only taken in the meeting it was first taken in
  assert.equal(hands.result(OTHER, actionId, 'user-ana', { ok: true }), false);
  assert.equal(hands.result(M, actionId, 'user-ana', { ok: true }), true);
});

test('the same result sent again by the same user is taken again for two minutes, and changes nothing', async () => {
  const s = setup();
  const ana = s.panel('user-ana', 'host', ['post_to_chat']);
  const running = s.hands.run(M, POST);
  const { actionId } = ana.got[0].data;
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: true }), true);
  assert.deepEqual(await running, { ok: true });
  // the panel never got the response and sends it again
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: true }), true);
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: true }), true);
  assert.equal(s.hands.pending(), 0);
  // another verdict, another user, another meeting: refused as before
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: false }), false);
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: false, code: 'not_found' }), false);
  assert.equal(s.hands.result(M, actionId, 'user-cy', { ok: true }), false);
  assert.equal(s.hands.result('ANOTHER==', actionId, 'user-ana', { ok: true }), false);
  // someone who stopped being an owner is not answered
  s.t.owners = ['user-cy'];
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: true }), false);
  s.t.owners = ['user-ana', 'user-cy'];
  // two minutes after the first, no more
  s.advance(2 * 60 * 1000 - 1);
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: true }), true);
  s.advance(1);
  assert.equal(s.hands.result(M, actionId, 'user-ana', { ok: true }), false);

  // a failure is repeated by its code; no code is "the SDK failed", as the first time
  const failing = s.hands.run(M, POST);
  const failedId = ana.got[1].data.actionId;
  assert.equal(s.hands.result(M, failedId, 'user-ana', { ok: false }), true);
  assert.deepEqual(await failing, { ok: false, code: 'sdk_error' });
  assert.equal(s.hands.result(M, failedId, 'user-ana', { ok: false, code: 'sdk_error' }), true);
  assert.equal(s.hands.result(M, failedId, 'user-ana', { ok: false, code: 'not_found' }), false);
  assert.equal(s.hands.result(M, failedId, 'user-ana', { ok: true }), false);

  // an action that timed out was never reported: a late result is still refused
  const late = s.hands.run(M, POST);
  s.advance(15000);
  assert.deepEqual(await late, { ok: false, code: 'timeout' });
  assert.equal(s.hands.result(M, ana.got[2].data.actionId, 'user-ana', { ok: true }), false);
});

test('what is remembered of results is bounded, and goes with the meeting', async () => {
  const s = setup({ maxReported: 3 });
  const ana = s.panel('user-ana', 'host', ['post_to_chat']);
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const running = s.hands.run(M, POST);
    ids.push(ana.got[i].data.actionId);
    s.hands.result(M, ids[i], 'user-ana', { ok: true });
    await running;
    s.advance(1000);
  }
  assert.equal(s.hands.remembered(), 3);
  // the oldest went first
  assert.equal(s.hands.result(M, ids[0], 'user-ana', { ok: true }), false);
  assert.equal(s.hands.result(M, ids[4], 'user-ana', { ok: true }), true);
  // old ones go when a new one comes
  s.advance(2 * 60 * 1000);
  const running = s.hands.run(M, POST);
  s.hands.result(M, ana.got[5].data.actionId, 'user-ana', { ok: true });
  await running;
  assert.equal(s.hands.remembered(), 1);
  // forgotten with the meeting: a repeat is refused, and another meeting's stay
  s.hands.forget('ANOTHER==');
  assert.equal(s.hands.remembered(), 1);
  s.hands.forget(M);
  assert.equal(s.hands.remembered(), 0);
  assert.equal(s.hands.result(M, ana.got[5].data.actionId, 'user-ana', { ok: true }), false);
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
  // every tool of the panel can be announced, all of them at once too
  const all = ['post_to_chat', 'admit_from_waiting_room', 'invite_everyone', 'send_reaction', 'mute_participant'];
  assert.deepEqual(read({ zoomRole: 'host', can: all }), { zoomRole: 'host', can: all });
  for (const name of all) assert.deepEqual(read({ zoomRole: 'attendee', can: [name] }), { zoomRole: 'attendee', can: [name] });
  assert.deepEqual(read({ zoomRole: 'host', can: [...all, ...all] }).can, all);
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
let chosenCount = 0;
let clientIp;
let testNo = 0;
test.before(async () => { srv = await h.startServer(); });
test.beforeEach(() => {
  testNo += 1;
  clientIp = `10.7.0.${testNo}`;
  pick = async () => ({ tool: 'post_to_chat', args: { message: 'Back in five.' } });
  openrouter.generateLiveNotes = async () => ({ summary: 'They ship Friday.', decisions: [], actionItems: [] });
  openrouter.answerFromTranscript = async () => 'On Friday.';
  openrouter.chooseTool = async (input) => { chosenCount += 1; return pick(input); };
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
  assert.match(res.body.action.id, UUID);
  assert.deepEqual(res.body, {
    answer: 'Done: posted to chat.', action: { id: res.body.action.id, tool: 'post_to_chat', status: 'done', label: 'Posted to chat' },
  });
  await h.wait(50);
  // the id in the answer is the one the panels are told about, so a panel can match the two
  for (const ws of [ownerPanel, benPanel, guestPanel]) {
    assert.deepEqual([of(ws, 'arlo.did').at(-1).data.action.id, of(ws, 'arlo.did').at(-1).data.action.label], [res.body.action.id, 'Posted to chat']);
  }
  assert.equal(of(ownerPanel, 'arlo.did').length, 1);

  // finished. The panel did not get the response and sends the same result again: answered the same
  const again = await report(m, sent.actionId, { ok: true });
  assert.deepEqual([again.status, again.body], [200, { received: true }]);
  // another verdict, or another owner's or a participant's retry, is refused as before
  assert.equal((await report(m, sent.actionId, { ok: false })).status, 404);
  assert.equal((await report(m, sent.actionId, { ok: false, code: 'sdk_error' })).status, 404);
  assert.equal((await report(m, sent.actionId, { ok: true }, m.participant)).status, 403);
  // and it changed nothing: nobody is told twice
  await h.wait(50);
  assert.equal(of(ownerPanel, 'arlo.did').length, 1);
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
    const { body } = await asking;
    assert.deepEqual(body, {
      answer: sentence,
      action: {
        id: body.action.id, tool: 'admit_from_waiting_room', status: 'failed', label: 'Asked to admit James from the waiting room',
      },
    });
    // a failure reported twice is answered twice
    assert.equal((await report(m, sent.actionId, { ok: false, code })).status, 200);
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

const NO_CHAT_PANEL = 'Open Arlo to let it post in the chat.';
const NO_HOST_PANEL = 'Arlo needs the host\'s panel for that.';

test('announcements: only an owner\'s, only valid ones, and the newest counts', async () => {
  const m = await meetingWith('AH-ANNOUNCE==', { secondOwner: true });
  // nobody announced anything
  const quiet = await panel(m.meetingId, m.owner);
  const none = await ask(m, POST_IT);
  assert.deepEqual([none.body.answer, none.body.action.status, none.body.action.label], [NO_CHAT_PANEL, 'failed', NO_CHAT_PANEL]);

  // an announcement that is not one is ignored, and the socket stays open
  for (const payload of [{ zoomRole: 'host', can: ['share_notes'] }, { zoomRole: 'host' }, 'host', null, { zoomRole: 'host', can: ['post_to_chat'], userId: m.ana.user.id }]) {
    quiet.socket.send(JSON.stringify({ type: 'arlo.hands', payload }));
  }
  await h.wait(50);
  assert.equal((await ask(m, POST_IT)).body.answer, NO_CHAT_PANEL);
  assert.equal(quiet.socket.readyState, 1);

  // the other owner's panel can, and is the host's: it is still not used for a request the first owner typed
  const cyPanel = await panel(m.meetingId, m.owner2, HOST);
  assert.equal((await ask(m, POST_IT)).body.answer, NO_CHAT_PANEL);
  await h.wait(50);
  assert.deepEqual(of(cyPanel, 'arlo.action'), []);
  // his own request runs on it, and only he may report the result
  cyPanel.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'attendee', can: ['post_to_chat'] } }));
  await h.wait(50);
  const asking = ask(m, POST_IT, m.owner2);
  const sent = await actionSent(cyPanel);
  assert.equal((await report(m, sent.actionId, { ok: true }, m.owner)).status, 404);
  assert.equal((await report(m, sent.actionId, { ok: true }, m.owner2)).status, 200);
  assert.equal((await asking).body.answer, 'Done: posted to chat.');
  assert.deepEqual(of(quiet, 'arlo.action'), []);

  // an attendee cannot admit; announcing again as host changes that
  pick = async () => ({ tool: 'admit_from_waiting_room', args: { name: 'James' } });
  cyPanel.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'attendee', can: ['post_to_chat', 'admit_from_waiting_room'] } }));
  await h.wait(50);
  const cannot = await ask(m, 'admit James', m.owner2);
  assert.deepEqual([cannot.body.answer, cannot.body.action.label], [NO_HOST_PANEL, NO_HOST_PANEL]);
  cyPanel.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'coHost', can: ['post_to_chat', 'admit_from_waiting_room'] } }));
  await h.wait(50);
  // the first owner is not the host: her request does not borrow his panel
  assert.equal((await ask(m, 'admit James')).body.answer, NO_HOST_PANEL);
  const admitting = ask(m, 'admit James', m.owner2);
  const admit = await actionSent(cyPanel, 2);
  await report(m, admit.actionId, { ok: true }, m.owner2);
  assert.equal((await admitting).body.answer, 'Done: admitted James from the waiting room.');

  // announcing nothing takes the hands away again
  cyPanel.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'coHost', can: [] } }));
  await h.wait(50);
  assert.equal((await ask(m, 'admit James', m.owner2)).body.answer, NO_HOST_PANEL);
  // and so does closing the panel
  cyPanel.socket.send(JSON.stringify({ type: 'arlo.hands', payload: { zoomRole: 'coHost', can: ['admit_from_waiting_room'] } }));
  await h.wait(50);
  cyPanel.socket.close();
  await h.wait(100);
  assert.equal((await ask(m, 'admit James', m.owner2)).body.answer, NO_HOST_PANEL);
  closeAll(quiet);
});

test('an owner\'s panel open in another meeting is not this meeting\'s hands, and is told nothing of this meeting', async () => {
  const m = await meetingWith('AH-ELSEWHERE==');
  const otherPass = await access('AH-ELSEWHERE-OTHER==');
  const elsewhere = await panel('AH-ELSEWHERE-OTHER==', cookies(otherPass, m.ana.session), HOST);
  const here = await panel(m.meetingId, m.owner);
  // a restart of her stream lists that socket under this meeting too
  await status(m.meetingId, { status: 'rtms_started', streamId: 's1', operatorId: m.ana.zoomUserId });
  assert.equal((await ask(m, POST_IT)).body.answer, NO_CHAT_PANEL);
  assert.deepEqual(of(elsewhere, 'arlo.action'), []);

  // what Arlo did here: her own private answer, and something everyone in this meeting is told
  pick = async () => ({ tool: 'answer_from_meeting', args: { question: 'When do we ship?' } });
  assert.equal((await ask(m, 'When do we ship?')).status, 200);
  pick = async () => ({ tool: 'share_notes', args: {} });
  assert.equal((await ask(m, 'Share the notes')).body.answer, 'Done: shared the notes with everyone.');
  await h.wait(100);
  assert.deepEqual(of(here, 'arlo.did').map((msg) => [msg.data.action.tool, msg.data.action.public]),
    [['post_to_chat', true], ['answer_from_meeting', false], ['share_notes', true]]);
  // the socket verified for the other meeting gets none of it, though it is hers and listed here
  assert.deepEqual(of(elsewhere, 'arlo.did'), []);
  assert.deepEqual(of(elsewhere, 'arlo.thinking'), []);
  // called directly too: a socket is told only of the meeting it is verified for
  const { sendArloDid } = require('../src/services/websocket');
  const action = { id: crypto.randomUUID(), tool: 'share_notes', label: 'Shared the notes with everyone', status: 'done', public: true };
  assert.equal(sendArloDid(m.meetingId, action, { everyone: true }), 1);
  assert.equal(sendArloDid(m.meetingId, action, { everyone: false, userIds: [m.ana.user.id] }), 1);
  await h.wait(50);
  assert.deepEqual(of(elsewhere, 'arlo.did'), []);
  assert.equal(of(here, 'arlo.did').length, 5);
  closeAll(elsewhere, here);
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

test('two owners and one sheet: the first answer wins, the sheet closes on both, and it runs on the panel of the one who agreed', async () => {
  const m = await meetingWith('AH-SHEET==', { secondOwner: true });
  const anaPanel = await panel(m.meetingId, m.owner, HOST);
  const cyPanel = await panel(m.meetingId, m.owner2, { zoomRole: 'attendee', can: ['post_to_chat'] });
  const benPanel = await panel(m.meetingId, m.participant);
  pick = async () => ({ tool: 'post_to_chat', args: { message: 'Lunch is here.' } });
  await say(m.meetingId, 'Arlo, post lunch is here to the chat.');
  const sheet = (await until(() => of(anaPanel, 'arlo.approval')[0])).data;
  assert.deepEqual([sheet.kind, sheet.question, sheet.body, sheet.primaryLabel, sheet.askedBy, sheet.askerVerified],
    ['agent_action', 'Post this in the meeting chat?', 'Lunch is here.', 'Post to chat', 'Ben', false]);
  assert.deepEqual(of(cyPanel, 'arlo.approval').map((msg) => msg.data), [sheet]);
  assert.deepEqual(of(benPanel, 'arlo.approval'), []);
  // nothing is sent to a panel before an owner agreed
  assert.deepEqual(of(anaPanel, 'arlo.action').concat(of(cyPanel, 'arlo.action')), []);

  // Cy agrees first; Ana is too late
  const agreed = await call('POST', m.meetingId, `approvals/${sheet.id}`, { headers: m.owner2, body: { approve: true } });
  assert.deepEqual([agreed.status, agreed.body], [200, { id: sheet.id, outcome: 'approved' }]);
  assert.equal((await call('POST', m.meetingId, `approvals/${sheet.id}`, { headers: m.owner, body: { approve: false } })).status, 404);
  // it runs on Cy's panel, an attendee's, and not on the host's: Ana pressed nothing
  const sent = await actionSent(cyPanel);
  assert.deepEqual([sent.tool, sent.args], ['post_to_chat', { message: 'Arlo: Lunch is here.' }]);
  await h.wait(100);
  assert.deepEqual(of(anaPanel, 'arlo.action'), []);
  for (const ws of [anaPanel, cyPanel]) {
    assert.deepEqual(of(ws, 'arlo.approval.closed').map((msg) => msg.data), [{ meetingId: m.meetingId, id: sheet.id, outcome: 'approved' }]);
  }
  assert.equal((await report(m, sent.actionId, { ok: true }, m.owner)).status, 404);
  assert.equal((await report(m, sent.actionId, { ok: true }, m.owner2)).status, 200);
  const did = await until(() => of(benPanel, 'arlo.did').find((msg) => msg.data.action.status === 'done'));
  assert.equal(did.data.action.label, 'Posted to chat');
  closeAll(anaPanel, cyPanel, benPanel);
});

test('admitting: only an owner whose panel is a host\'s gets the sheet, may answer it, and admits', async () => {
  const m = await meetingWith('AH-ADMIT-SHEET==', { secondOwner: true });
  const anaPanel = await panel(m.meetingId, m.owner, { zoomRole: 'attendee', can: ['post_to_chat', 'admit_from_waiting_room'] });
  const cyPanel = await panel(m.meetingId, m.owner2, HOST);
  pick = async () => ({ tool: 'admit_from_waiting_room', args: { name: 'James' } });
  await say(m.meetingId, 'Arlo, admit James from the waiting room.');
  const sheet = (await until(() => of(cyPanel, 'arlo.approval')[0])).data;
  assert.deepEqual([sheet.question, sheet.primaryLabel, 'body' in sheet, 'forUserIds' in sheet], ['Admit James from the waiting room?', 'Admit James', false, false]);
  await h.wait(50);
  // Ana's panel could not do it: she is not asked, does not find it after a reload, and cannot answer it
  assert.deepEqual(of(anaPanel, 'arlo.approval'), []);
  assert.deepEqual((await call('GET', m.meetingId, 'approvals', { headers: m.owner })).body, { approvals: [] });
  assert.equal((await call('GET', m.meetingId, 'approvals', { headers: m.owner2 })).body.approvals.length, 1);
  for (const approve of [true, false]) {
    assert.equal((await call('POST', m.meetingId, `approvals/${sheet.id}`, { headers: m.owner, body: { approve } })).status, 404);
  }
  assert.equal((await call('POST', m.meetingId, `approvals/${sheet.id}`, { headers: m.owner2, body: { approve: true } })).status, 200);
  const sent = await actionSent(cyPanel);
  assert.deepEqual([sent.tool, sent.args], ['admit_from_waiting_room', { name: 'James' }]);
  assert.deepEqual(of(anaPanel, 'arlo.action'), []);
  await report(m, sent.actionId, { ok: true }, m.owner2);
  const did = await until(() => of(anaPanel, 'arlo.did').find((msg) => msg.data.action.status === 'done'));
  assert.equal(did.data.action.label, 'Admitted James from the waiting room');

  // the host's panel closes: nobody could admit, so there is no sheet at all, and the record says why
  cyPanel.socket.close();
  await h.wait(100);
  await say(m.meetingId, 'Arlo, admit James from the waiting room again.');
  const failed = await until(() => of(anaPanel, 'arlo.did').find((msg) => msg.data.action.status === 'failed'));
  assert.equal(failed.data.action.label, NO_HOST_PANEL);
  assert.deepEqual(of(anaPanel, 'arlo.approval'), []);
  closeAll(anaPanel);
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

test('forgetting a meeting through the runtime ends what its hands and its detector hold', async () => {
  const m = await meetingWith('AH-FORGET==');
  const ownerPanel = await panel(m.meetingId, m.owner, HOST);
  const runtime = getAgentRuntime();
  const before = { pending: runtime.hands.pending(), remembered: runtime.hands.remembered(), heard: runtime.detector.tracked() };

  // an action is with the owner's panel, and another one was reported a moment ago
  const done = runtime.hands.run(m.meetingId, { tool: 'post_to_chat', args: { message: 'Arlo: one' }, userId: m.ana.user.id });
  const first = await actionSent(ownerPanel);
  assert.equal(runtime.hands.result(m.meetingId, first.actionId, m.ana.user.id, { ok: true }), true);
  assert.deepEqual(await done, { ok: true });
  const waiting = runtime.hands.run(m.meetingId, { tool: 'post_to_chat', args: { message: 'Arlo: two' }, userId: m.ana.user.id });
  const second = await actionSent(ownerPanel, 2);
  // and someone has begun to say something to Arlo
  runtime.lineStored(m.meetingId, { text: 'Arlo, share', speakerId: '8', speakerLabel: 'Ben' });
  assert.deepEqual(
    [runtime.hands.pending(), runtime.hands.remembered(), runtime.detector.tracked()],
    [before.pending + 1, before.remembered + 1, before.heard + 1],
  );

  // the runtime's own forget, as the meeting lifecycle calls it. The store still holds the meeting,
  // and she is still an owner: only the forget itself can end these
  runtime.forget(m.meetingId);
  const outcome = await Promise.race([waiting, h.wait(500).then(() => 'still waiting')]);
  assert.deepEqual(outcome, { ok: false, code: 'gone' });
  assert.deepEqual(
    [runtime.hands.pending(), runtime.hands.remembered(), runtime.detector.tracked()],
    [before.pending, before.remembered, before.heard],
  );
  assert.equal(runtime.hands.result(m.meetingId, first.actionId, m.ana.user.id, { ok: true }), false);
  assert.equal(runtime.hands.result(m.meetingId, second.actionId, m.ana.user.id, { ok: true }), false);
  // what was being heard is gone: the rest of the sentence is not a request any more
  chosenCount = 0;
  runtime.lineStored(m.meetingId, { text: 'the notes with everyone.', speakerId: '8', speakerLabel: 'Ben' });
  await h.wait(100);
  assert.equal(chosenCount, 0);
  closeAll(ownerPanel);
});


// --- inviting everyone, a reaction, muting: through the running server -----------

const ALL_HANDS = { zoomRole: 'host', can: ['post_to_chat', 'admit_from_waiting_room', 'invite_everyone', 'send_reaction', 'mute_participant'] };
const state = (m, headers = m.owner) => call('GET', m.meetingId, 'state', { headers });

const OWN_SHEET = 'Check the request on your screen and confirm it.';
const OWNERS_ASKED = 'I asked the person who brought Arlo in to approve that.';
const approveSheet = (m, id, headers = m.owner) => call('POST', m.meetingId, `approvals/${id}`, { headers, body: { approve: true } });
const sheetSent = async (ws, n = 1) => (await until(() => (of(ws, 'arlo.approval').length >= n ? of(ws, 'arlo.approval')[n - 1] : null))).data;
const didEnd = (ws, id) => until(() => of(ws, 'arlo.did').map((msg) => msg.data.action).find((action) => action.id === id && action.status !== 'waiting_approval'));

test('"invite everyone", typed by the owner: the sheet first, then the notes are shared the one way they ever are and the owner\'s panel is sent the invitation', async () => {
  const m = await meetingWith('AH-INVITE==');
  const ownerPanel = await panel(m.meetingId, m.owner, ALL_HANDS);
  const benPanel = await panel(m.meetingId, m.participant, ALL_HANDS);
  pick = async () => ({ tool: 'invite_everyone', args: {} });
  assert.equal((await state(m)).body.notesShared, false);

  // the owner's own words, and still the sheet: it shares the notes too
  const asked = await ask(m, 'Invite everyone to see the notes');
  assert.deepEqual(asked.body, {
    answer: OWN_SHEET,
    action: { id: asked.body.action.id, tool: 'invite_everyone', status: 'waiting_approval', label: 'Asked to share the notes and invite everyone to open Arlo' },
  });
  const sheet = await sheetSent(ownerPanel);
  assert.deepEqual([sheet.question, sheet.primaryLabel], ['Share the notes and invite everyone to open Arlo?', 'Share and invite']);
  await h.wait(50);
  assert.equal((await state(m)).body.notesShared, false);
  assert.deepEqual(of(ownerPanel, 'arlo.action'), []);

  assert.equal((await approveSheet(m, sheet.id)).status, 200);
  const sent = await actionSent(ownerPanel);
  assert.deepEqual(sent, { meetingId: m.meetingId, actionId: sent.actionId, tool: 'invite_everyone', args: {} });
  // by the time the panel is asked to invite, sharing is on, and everyone's panel was told
  assert.equal((await state(m, m.participant)).body.notesShared, true);
  assert.equal(of(benPanel, 'arlo.state').at(-1).data.notesShared, true);
  assert.deepEqual(of(benPanel, 'arlo.action'), []);

  assert.equal((await report(m, sent.actionId, { ok: true })).status, 200);
  const done = await didEnd(ownerPanel, asked.body.action.id);
  assert.deepEqual([done.status, done.label], ['done', 'Shared the notes and invited everyone to open Arlo']);

  // shared already: only the invitation. The panel fails: sharing stays on, and the record says both halves
  const again = await ask(m, 'invite everyone again');
  assert.equal((await approveSheet(m, (await sheetSent(ownerPanel, 2)).id)).status, 200);
  const second = await actionSent(ownerPanel, 2);
  assert.equal(second.tool, 'invite_everyone');
  assert.equal((await report(m, second.actionId, { ok: false, code: 'unsupported' })).status, 200);
  const failed = await didEnd(ownerPanel, again.body.action.id);
  assert.deepEqual([failed.status, failed.label], ['failed', 'Shared the notes. Couldn\'t send the invitation.']);
  assert.equal((await state(m)).body.notesShared, true);
  closeAll(ownerPanel, benPanel);
});

test('"open the notes for everyone" through the running server: the sheet, sharing on, the panel asked with no arguments, and its report of a fallback', async () => {
  const m = await meetingWith('AH-OPEN-NOTES==');
  const CAN_OPEN = { zoomRole: 'attendee', can: ['post_to_chat', 'open_notes_for_everyone'] };
  const ownerPanel = await panel(m.meetingId, m.owner, CAN_OPEN);
  pick = async () => ({ tool: 'open_notes_for_everyone', args: {} });

  const asked = await ask(m, 'open the notes for everyone');
  assert.deepEqual(asked.body, {
    answer: OWN_SHEET,
    action: { id: asked.body.action.id, tool: 'open_notes_for_everyone', status: 'waiting_approval', label: 'Asked to open the notes for everyone' },
  });
  const sheet = await sheetSent(ownerPanel);
  assert.deepEqual([sheet.question, sheet.primaryLabel, 'body' in sheet],
    ['Open the notes for everyone in the meeting? Your Arlo view will be shared, and the notes stay shared until you stop sharing.', 'Open notes', false]);
  await h.wait(50);
  assert.equal((await state(m)).body.notesShared, false);
  assert.deepEqual(of(ownerPanel, 'arlo.action'), []);

  assert.equal((await approveSheet(m, sheet.id)).status, 200);
  const sent = await actionSent(ownerPanel);
  assert.deepEqual(sent, { meetingId: m.meetingId, actionId: sent.actionId, tool: 'open_notes_for_everyone', args: {} });
  assert.equal((await state(m, m.participant)).body.notesShared, true);
  assert.equal((await report(m, sent.actionId, { ok: true })).status, 200);
  const done = await didEnd(ownerPanel, asked.body.action.id);
  assert.deepEqual([done.status, done.label], ['done', 'Opened the notes for everyone']);

  // Collaborate did not start: the notes stay shared and nothing is sent in its place
  const again = await ask(m, 'open the notes for everyone again');
  assert.equal((await approveSheet(m, (await sheetSent(ownerPanel, 2)).id)).status, 200);
  const second = await actionSent(ownerPanel, 2);
  assert.equal((await report(m, second.actionId, { ok: false, code: 'fell_back_invite' })).status, 400);
  assert.equal((await report(m, second.actionId, { ok: false, code: 'sdk_error' })).status, 200);
  const fellBack = await didEnd(ownerPanel, again.body.action.id);
  assert.deepEqual([fellBack.status, fellBack.label],
    ['failed', 'Shared the notes. Couldn\'t open them for everyone.']);
  assert.equal((await state(m)).body.notesShared, true);
  closeAll(ownerPanel);
});

test('"invite everyone" with no panel that can: nothing is shared, and the record says to open Arlo', async () => {
  const m = await meetingWith('AH-INVITE-NOPANEL==');
  // a panel that did not announce inviting (an older panel)
  const ownerPanel = await panel(m.meetingId, m.owner, HOST);
  pick = async () => ({ tool: 'invite_everyone', args: {} });
  const asked = await ask(m, 'invite everyone');
  assert.equal(asked.body.action.status, 'waiting_approval');
  assert.equal((await approveSheet(m, (await sheetSent(ownerPanel)).id)).status, 200);
  const failed = await didEnd(ownerPanel, asked.body.action.id);
  assert.deepEqual([failed.status, failed.label], ['failed', 'Open Arlo to let it do that.']);
  assert.deepEqual(of(ownerPanel, 'arlo.action'), []);
  assert.equal((await state(m)).body.notesShared, false);
  closeAll(ownerPanel);
});

test('what the asker is told while a sheet waits: an owner looks at their own screen, anyone else is told the owners were asked', async () => {
  const m = await meetingWith('AH-SHEET-WORDS==');
  const ownerPanel = await panel(m.meetingId, m.owner, ALL_HANDS);
  assert.equal((await call('PUT', m.meetingId, 'settings', { headers: m.owner, body: { whoCanAsk: 'anyone' } })).status, 200);
  pick = async () => ({ tool: 'share_notes', args: {} });
  // an owner, and what the model picked is not in what they typed
  assert.equal((await ask(m, 'what did we decide?')).body.answer, OWN_SHEET);
  // someone who is not an owner
  assert.equal((await ask(m, 'share the notes', m.participant)).body.answer, OWNERS_ASKED);
  closeAll(ownerPanel);
});

test('a reaction and a mute through the panel: the arguments the panel gets, and what the asker is told when it fails', async () => {
  const m = await meetingWith('AH-REACT-MUTE==');
  const ownerPanel = await panel(m.meetingId, m.owner, ALL_HANDS);

  pick = async () => ({ tool: 'send_reaction', args: { reaction: 'clap' } });
  const clapping = ask(m, 'give that a round of applause');
  const clap = await actionSent(ownerPanel, 1);
  assert.deepEqual([clap.tool, clap.args], ['send_reaction', { reaction: 'clap' }]);
  await report(m, clap.actionId, { ok: true });
  const clapped = (await clapping).body;
  assert.deepEqual([clapped.answer, clapped.action.label], ['Done: sent a \u{1F44F} reaction.', 'Sent a \u{1F44F} reaction']);

  pick = async () => ({ tool: 'mute_participant', args: { name: 'Danny' } });
  const cases = [
    ['not_found', 'I couldn\'t find Danny in the meeting.'],
    ['several_match', 'Several people in the meeting match Danny. Ask again with the full name.'],
    ['unsupported', 'I couldn\'t do that: this version of Zoom or Arlo cannot do that.'],
    ['sdk_error', 'I couldn\'t do that: Zoom did not do it.'],
    ['not_allowed', 'I couldn\'t do that: that is not allowed here.'],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [code, sentence] = cases[i];
    const asking = ask(m, 'Mute Danny');
    const sent = await actionSent(ownerPanel, i + 2);
    assert.deepEqual([sent.tool, sent.args], ['mute_participant', { name: 'Danny' }]);
    assert.equal((await report(m, sent.actionId, { ok: false, code })).status, 200);
    const { body } = await asking;
    assert.deepEqual(body, { answer: sentence, action: { id: body.action.id, tool: 'mute_participant', status: 'failed', label: 'Asked to mute Danny' } });
  }
  const muting = ask(m, 'Mute Danny');
  const sent = await actionSent(ownerPanel, cases.length + 2);
  await report(m, sent.actionId, { ok: true });
  assert.deepEqual((await muting).body.answer, 'Done: muted Danny.');

  // "unmute Danny": the owner gets the sheet, and nothing is sent to the panel
  const before = of(ownerPanel, 'arlo.action').length;
  const unmute = await ask(m, 'unmute Danny');
  assert.equal(unmute.body.action.status, 'waiting_approval');
  assert.equal(unmute.body.answer, OWN_SHEET);
  await h.wait(50);
  assert.equal(of(ownerPanel, 'arlo.action').length, before);
  const sheet = of(ownerPanel, 'arlo.approval').at(-1).data;
  assert.deepEqual([sheet.question, sheet.primaryLabel], ['Mute Danny?', 'Mute']);
  closeAll(ownerPanel);
});

test('muting needs a host\'s panel: an owner who is an attendee is told so, and a reaction needs their own panel', async () => {
  const m = await meetingWith('AH-MUTE-HOST==');
  const ownerPanel = await panel(m.meetingId, m.owner, { ...ALL_HANDS, zoomRole: 'attendee' });
  pick = async () => ({ tool: 'mute_participant', args: { name: 'Danny' } });
  const res = await ask(m, 'mute Danny');
  assert.deepEqual([res.body.answer, res.body.action.label], [NO_HOST_PANEL, NO_HOST_PANEL]);
  assert.deepEqual(of(ownerPanel, 'arlo.action'), []);
  closeAll(ownerPanel);
  await h.wait(50);
  pick = async () => ({ tool: 'send_reaction', args: { reaction: 'heart' } });
  const none = await ask(m, 'send a heart');
  assert.deepEqual([none.body.answer, none.body.action.label], ['Open Arlo to let it do that.', 'Open Arlo to let it do that.']);
});
