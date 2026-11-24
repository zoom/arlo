// The approvals service on its own: a question put to a meeting's owners that
// one of them answers, or that runs out. Time and timers are the test's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApprovals, approvalMessageData, APPROVAL_KINDS } = require('../src/services/approvals');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const M = 'MEETING-APPROVALS==';

function setup(options = {}) {
  let clock = 1_000_000;
  const timers = []; // { fn, at, cancelled, unrefd }
  const closed = [];
  const approvals = createApprovals({
    now: () => clock,
    schedule: (fn, ms) => {
      const timer = { fn, at: clock + ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    onClosed: (meetingId, approval, outcome) => closed.push({ meetingId, approval, outcome }),
    ...options,
  });
  /** Move the clock and run the timers that are due. */
  const advance = (ms) => {
    clock += ms;
    for (const timer of timers) {
      if (!timer.cancelled && !timer.done && timer.at <= clock) {
        timer.done = true;
        timer.fn();
      }
    }
  };
  const live = () => timers.filter((timer) => !timer.cancelled && !timer.done).length;
  return { approvals, advance, closed, live, clock: () => clock };
}

const ask = (approvals, userId = 'user-ben', name = 'Ben Okafor', meetingId = M) => approvals.open(
  meetingId, { kind: 'share_notes', askedByUserId: userId, askedByName: name },
);

test('the kinds: a request for the notes, and something Arlo was asked to do', () => {
  assert.deepEqual([...APPROVAL_KINDS], ['share_notes', 'agent_action']);
});

test('open gives an id and when it runs out; get and listOpen show it', () => {
  const { approvals, clock } = setup();
  const opened = ask(approvals);
  assert.deepEqual(Object.keys(opened), ['id', 'expiresAt']);
  assert.match(opened.id, UUID);
  assert.equal(opened.expiresAt, clock() + 60000);

  const expected = {
    id: opened.id, kind: 'share_notes', askedByUserId: 'user-ben', askedByName: 'Ben Okafor', expiresAt: opened.expiresAt,
  };
  assert.deepEqual(approvals.get(M, opened.id), expected);
  assert.deepEqual(approvals.listOpen(M), [expected]);
  assert.equal(approvals.get('ANOTHER==', opened.id), null);
  assert.deepEqual(approvals.listOpen('ANOTHER=='), []);
});

test('open refuses what is not a known kind, a user id or a meeting id', () => {
  const { approvals, live } = setup();
  for (const kind of ['agent', 'post_to_chat', '', null, undefined, 42, 'constructor', '__proto__', ['share_notes']]) {
    assert.equal(approvals.open(M, { kind, askedByUserId: 'user-ben', askedByName: null }), null, String(kind));
  }
  for (const userId of ['', null, undefined, 42, {}]) {
    assert.equal(approvals.open(M, { kind: 'share_notes', askedByUserId: userId, askedByName: null }), null);
  }
  for (const meetingId of ['', null, undefined, 42, 'x'.repeat(257)]) {
    assert.equal(approvals.open(meetingId, { kind: 'share_notes', askedByUserId: 'user-ben', askedByName: null }), null);
  }
  assert.equal(approvals.open(M), null);
  assert.equal(live(), 0);
  assert.deepEqual(approvals.listOpen(M), []);
});

test('a name that is not a non-empty string is kept as no name', () => {
  const { approvals } = setup();
  let n = 0;
  for (const name of [null, undefined, '', 42, {}]) {
    n += 1;
    const opened = approvals.open(M, { kind: 'share_notes', askedByUserId: `user-${n}`, askedByName: name });
    assert.equal(approvals.get(M, opened.id).askedByName, null);
  }
});

test('answers: declined, approved, failed; the owner is told through onClosed', () => {
  const { approvals, closed } = setup();
  const a = ask(approvals, 'user-1');
  const b = ask(approvals, 'user-2');
  const c = ask(approvals, 'user-3');
  assert.equal(approvals.answer(M, a.id, { byUserId: 'owner-1', approve: false }), 'declined');
  assert.equal(approvals.answer(M, b.id, { byUserId: 'owner-1', approve: true, done: true }), 'approved');
  assert.equal(approvals.answer(M, c.id, { byUserId: 'owner-1', approve: true, done: false }), 'failed');
  assert.deepEqual(closed.map((one) => [one.meetingId, one.approval.id, one.approval.askedByUserId, one.outcome]), [
    [M, a.id, 'user-1', 'declined'], [M, b.id, 'user-2', 'approved'], [M, c.id, 'user-3', 'failed'],
  ]);
  assert.deepEqual(approvals.listOpen(M), []);
  assert.equal(approvals.get(M, a.id), null);
});

test('approved without "done" is not an approval: the notes were not posted', () => {
  const { approvals } = setup();
  const a = ask(approvals);
  assert.equal(approvals.answer(M, a.id, { byUserId: 'owner-1', approve: true }), 'failed');
});

test('the first valid answer wins; a second one, an unknown id and a bad answer are null', () => {
  const { approvals, closed, live } = setup();
  const a = ask(approvals);
  assert.equal(approvals.answer(M, 'not-an-id', { byUserId: 'owner-1', approve: true, done: true }), null);
  assert.equal(approvals.answer('ANOTHER==', a.id, { byUserId: 'owner-1', approve: true, done: true }), null);
  // not an answer: the approval stays open
  assert.equal(approvals.answer(M, a.id, { byUserId: 'owner-1', approve: 'yes' }), null);
  assert.equal(approvals.answer(M, a.id, { byUserId: '', approve: true, done: true }), null);
  assert.equal(approvals.answer(M, a.id), null);
  assert.equal(approvals.listOpen(M).length, 1);

  assert.equal(approvals.answer(M, a.id, { byUserId: 'owner-1', approve: true, done: true }), 'approved');
  assert.equal(approvals.answer(M, a.id, { byUserId: 'owner-2', approve: false }), null);
  assert.equal(closed.length, 1);
  assert.equal(live(), 0); // its timer went with it
});

test('an approval runs out by its timer, with outcome "expired"', () => {
  const { approvals, advance, closed, live } = setup();
  const a = ask(approvals);
  advance(59999);
  assert.equal(approvals.listOpen(M).length, 1);
  advance(1);
  assert.deepEqual(closed.map((one) => [one.meetingId, one.approval.id, one.outcome]), [[M, a.id, 'expired']]);
  assert.deepEqual(approvals.listOpen(M), []);
  assert.equal(approvals.answer(M, a.id, { byUserId: 'owner-1', approve: true, done: true }), null);
  assert.equal(closed.length, 1);
  assert.equal(live(), 0);
});

test('past its time but the timer has not run: not listed, not answerable', () => {
  let clock = 5000;
  const approvals = createApprovals({ now: () => clock, schedule: () => () => {}, expiryMs: 1000 });
  const a = ask(approvals);
  clock += 1000;
  assert.deepEqual(approvals.listOpen(M), []);
  assert.equal(approvals.get(M, a.id), null);
  assert.equal(approvals.answer(M, a.id, { byUserId: 'owner-1', approve: false }), null);
});

test('one request per person per meeting every two minutes, open or not', () => {
  const { approvals, advance } = setup();
  const first = ask(approvals);
  assert.equal(approvals.mayOpen(M, 'share_notes', 'user-ben'), false);
  assert.equal(ask(approvals), null); // one is open
  approvals.answer(M, first.id, { byUserId: 'owner-1', approve: false });
  assert.equal(ask(approvals), null); // answered, but asked a moment ago
  // someone else, and the same person in another meeting, are not held back
  assert.notEqual(ask(approvals, 'user-cy'), null);
  assert.notEqual(ask(approvals, 'user-ben', 'Ben Okafor', 'ANOTHER=='), null);
  advance(119999);
  assert.equal(ask(approvals), null);
  advance(1);
  assert.equal(approvals.mayOpen(M, 'share_notes', 'user-ben'), true);
  assert.notEqual(ask(approvals), null);
});

test('bounded per meeting: no more open at once than maxPerMeeting', () => {
  const { approvals, advance } = setup({ maxPerMeeting: 3 });
  const opened = [1, 2, 3].map((n) => ask(approvals, `user-${n}`));
  assert.equal(opened.every(Boolean), true);
  assert.equal(ask(approvals, 'user-4'), null);
  assert.equal(approvals.listOpen(M).length, 3);
  // a refusal for being full does not count as having asked
  approvals.answer(M, opened[0].id, { byUserId: 'owner-1', approve: false });
  assert.notEqual(ask(approvals, 'user-4'), null);
  // oldest first
  assert.deepEqual(approvals.listOpen(M).map((one) => one.askedByUserId), ['user-2', 'user-3', 'user-4']);
  advance(60000);
  assert.deepEqual(approvals.listOpen(M), []);
});

test('who asked is remembered for a bounded number of people', () => {
  const { approvals } = setup({ maxPerMeeting: 2, maxAskersPerMeeting: 4 });
  for (let n = 1; n <= 10; n += 1) {
    const opened = ask(approvals, `user-${n}`);
    if (opened) approvals.answer(M, opened.id, { byUserId: 'owner-1', approve: false });
  }
  assert.ok(approvals.size().askers <= 4);
});

test('forget drops a meeting\'s approvals, timers and who asked; a late answer is null and nobody is told', () => {
  const { approvals, advance, closed, live } = setup();
  const a = ask(approvals);
  const other = ask(approvals, 'user-ben', 'Ben Okafor', 'ANOTHER==');
  assert.deepEqual(approvals.size(), { meetings: 2, open: 2, askers: 2 });
  approvals.forget(M);
  assert.deepEqual(approvals.size(), { meetings: 1, open: 1, askers: 1 });
  assert.equal(live(), 1);
  assert.equal(approvals.get(M, a.id), null);
  assert.deepEqual(approvals.listOpen(M), []);
  assert.equal(approvals.answer(M, a.id, { byUserId: 'owner-1', approve: true, done: true }), null);
  advance(60000);
  assert.deepEqual(closed.map((one) => one.approval.id), [other.id]); // only the other meeting's ran out
  // nothing left of the other one either, once it is forgotten
  approvals.forget('ANOTHER==');
  assert.deepEqual(approvals.size(), { meetings: 0, open: 0, askers: 0 });
  // and the person may ask again in a meeting that starts over
  assert.notEqual(ask(approvals), null);
  approvals.forget('never-seen');
});

test('a listener that throws does not undo a close', () => {
  const approvals = createApprovals({ now: () => 1, schedule: () => () => {}, onClosed: () => { throw new Error('boom'); } });
  const a = ask(approvals);
  assert.equal(approvals.answer(M, a.id, { byUserId: 'owner-1', approve: false }), 'declined');
  assert.deepEqual(approvals.listOpen(M), []);
});

test('the default timer does not keep the process alive, and nothing is logged', () => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const level of Object.keys(original)) console[level] = (...args) => lines.push(args.join(' '));
  try {
    const approvals = createApprovals({ expiryMs: 3600000 });
    const a = ask(approvals);
    approvals.answer(M, a.id, { byUserId: 'owner-1', approve: true, done: true });
    ask(approvals, 'user-cy', 'Cy Young'); // left open: an unref'd timer lets the test process end
  } finally {
    Object.assign(console, original);
  }
  assert.equal(lines.join('\n').includes('Ben Okafor'), false);
  assert.equal(lines.join('\n').includes('Cy Young'), false);
});

const agentAsk = (approvals, extra = {}, meetingId = M) => approvals.open(meetingId, {
  kind: 'agent_action',
  askedByUserId: null,
  askedByName: 'James',
  question: 'Admit James from the waiting room?',
  primaryLabel: 'Admit James',
  channel: 'voice',
  ...extra,
});

test('agent_action: carries the sheet\'s texts, needs no user id, and is not limited per asker', () => {
  const { approvals, clock } = setup();
  const first = agentAsk(approvals);
  assert.match(first.id, UUID);
  assert.deepEqual(approvals.get(M, first.id), {
    id: first.id,
    kind: 'agent_action',
    askedByUserId: null,
    askedByName: 'James',
    expiresAt: first.expiresAt,
    question: 'Admit James from the waiting room?',
    primaryLabel: 'Admit James',
    channel: 'voice',
    askerVerified: false,
  });
  // spoken requests have no user; the same person may have several open
  assert.notEqual(agentAsk(approvals), null);
  assert.notEqual(agentAsk(approvals, { askedByUserId: 'user-ben' }), null);
  assert.notEqual(agentAsk(approvals, { askedByUserId: 'user-ben' }), null);
  assert.equal(approvals.size().open, 4);
  assert.equal(approvals.size().askers, 0);
  // and a request for the notes by the same person is still its own thing
  assert.notEqual(ask(approvals, 'user-ben'), null);
  assert.equal(ask(approvals, 'user-ben'), null);

  assert.deepEqual(approvalMessageData(M, approvals.get(M, first.id), clock()), {
    meetingId: M,
    id: first.id,
    kind: 'agent_action',
    askedBy: 'James',
    askerVerified: false,
    expiresAt: first.expiresAt,
    expiresInMs: 60000,
    question: 'Admit James from the waiting room?',
    primaryLabel: 'Admit James',
    channel: 'voice',
  });
});

test('agent_action: the text that will be posted is kept as given, with what was asked and how', () => {
  const { approvals, clock } = setup();
  const body = 'On Friday.  Two spaces stay, as given ';
  const opened = agentAsk(approvals, {
    askedByUserId: 'user-ben', askedByName: 'Ben', question: 'Post Arlo\'s answer in the meeting chat?', primaryLabel: 'Post answer',
    body, request: 'when do we ship?', channel: 'panel', askerVerified: true,
  });
  const data = approvalMessageData(M, approvals.get(M, opened.id), clock());
  assert.deepEqual(data, {
    meetingId: M,
    id: opened.id,
    kind: 'agent_action',
    askedBy: 'Ben',
    askerVerified: true,
    expiresAt: opened.expiresAt,
    expiresInMs: 60000,
    question: 'Post Arlo\'s answer in the meeting chat?',
    primaryLabel: 'Post answer',
    channel: 'panel',
    body,
    request: 'when do we ship?',
  });
  // only `true` is verified
  for (const askerVerified of ['true', 1, {}, undefined, null, false]) {
    const one = agentAsk(approvals, { askerVerified });
    assert.equal(approvalMessageData(M, approvals.get(M, one.id)).askerVerified, false, String(askerVerified));
    approvals.answer(M, one.id, { byUserId: 'owner-1', approve: false });
  }
  // no body, no request: the fields are absent, not empty
  const plain = agentAsk(approvals, { body: null, request: undefined });
  assert.deepEqual(Object.keys(approvalMessageData(M, approvals.get(M, plain.id))),
    ['meetingId', 'id', 'kind', 'askedBy', 'expiresAt', 'expiresInMs', 'askerVerified', 'question', 'primaryLabel', 'channel']);
  // 500 and 200 characters are the most; a longer one is refused, never cut
  assert.notEqual(agentAsk(approvals, { body: 'b'.repeat(500), request: 'r'.repeat(200) }), null);
});

test('agent_action: refused without its texts, with texts that are too long, or with a bad asker', () => {
  const { approvals } = setup();
  for (const extra of [
    { question: undefined }, { question: '' }, { question: '   ' }, { question: 5 }, { question: 'q'.repeat(501) },
    { primaryLabel: undefined }, { primaryLabel: '' }, { primaryLabel: {} }, { primaryLabel: 'p'.repeat(121) },
    { askedByUserId: '' }, { askedByUserId: 5 }, { askedByUserId: {} }, { askedByUserId: 'x'.repeat(257) },
    { onOutcome: 'call me' },
    { body: 'b'.repeat(501) }, { body: '' }, { body: '   ' }, { body: 5 }, { body: ['x'] },
    { request: 'r'.repeat(201) }, { request: '' }, { request: {} },
    { channel: undefined }, { channel: 'chat' }, { channel: '' }, { channel: 5 },
  ]) {
    assert.equal(agentAsk(approvals, extra), null, JSON.stringify(extra));
  }
  assert.equal(approvals.size().open, 0);
});

test('share_notes keeps its shape: texts given to it are not kept', () => {
  const { approvals } = setup();
  const opened = approvals.open(M, {
    kind: 'share_notes', askedByUserId: 'user-ben', askedByName: 'Ben', question: 'Do anything?', primaryLabel: 'Yes',
  });
  assert.deepEqual(Object.keys(approvals.get(M, opened.id)), ['id', 'kind', 'askedByUserId', 'askedByName', 'expiresAt']);
  assert.deepEqual(Object.keys(approvalMessageData(M, approvals.get(M, opened.id))), ['meetingId', 'id', 'kind', 'askedBy', 'expiresAt', 'expiresInMs']);
});

test('whoever opened an approval is told once how it ended, and by whom', () => {
  const { approvals, advance, closed } = setup();
  const heard = [];
  const open = (name) => agentAsk(approvals, { onOutcome: (outcome, by) => heard.push([name, outcome, by]) });

  const a = open('a');
  assert.equal(approvals.answer(M, a.id, { byUserId: 'user-ana', approve: true, done: true }), 'approved');
  assert.deepEqual(heard, [['a', 'approved', { byUserId: 'user-ana' }]]);
  // the second owner is too late: nothing more is heard
  assert.equal(approvals.answer(M, a.id, { byUserId: 'user-cy', approve: false }), null);
  assert.equal(heard.length, 1);

  const b = open('b');
  assert.equal(approvals.answer(M, b.id, { byUserId: 'user-cy', approve: false }), 'declined');
  assert.deepEqual(heard[1], ['b', 'declined', { byUserId: 'user-cy' }]);

  open('c');
  advance(60000);
  assert.deepEqual(heard[2], ['c', 'expired', { byUserId: null }]);
  // the panels were told about all three, as for any approval
  assert.deepEqual(closed.map((one) => one.outcome), ['approved', 'declined', 'expired']);

  open('d');
  approvals.forget(M);
  assert.deepEqual(heard[3], ['d', 'forgotten', { byUserId: null }]);
  assert.equal(closed.length, 3); // nobody is left to tell
  assert.equal(heard.length, 4);
});

test('a listener that throws does not undo a close', () => {
  const { approvals, closed } = setup();
  const opened = agentAsk(approvals, { onOutcome: () => { throw new Error('listener'); } });
  assert.equal(approvals.answer(M, opened.id, { byUserId: 'user-ana', approve: false }), 'declined');
  assert.equal(approvals.get(M, opened.id), null);
  assert.equal(closed.length, 1);
});

test('what the panels are told carries the time left by the server\'s clock, a whole number never below zero', () => {
  const { approvals, clock } = setup();
  const opened = ask(approvals);
  const approval = approvals.get(M, opened.id);
  assert.equal(approvalMessageData(M, approval, clock()).expiresInMs, 60000);
  assert.equal(approvalMessageData(M, approval, clock() + 12345.6).expiresInMs, 47654);
  assert.equal(approvalMessageData(M, approval, clock() + 60000).expiresInMs, 0);
  assert.equal(approvalMessageData(M, approval, clock() + 999999).expiresInMs, 0);
  // without a time: this machine's clock, now
  const left = approvalMessageData(M, { ...approval, expiresAt: Date.now() + 5000 }).expiresInMs;
  assert.ok(Number.isInteger(left) && left > 4000 && left <= 5000);
  // an agent's sheet has it too, before its texts
  const sheet = approvals.open(M, { kind: 'agent_action', askedByName: 'Ben', question: 'Do it?', primaryLabel: 'Do it', channel: 'voice' });
  assert.deepEqual(
    Object.keys(approvalMessageData(M, approvals.get(M, sheet.id), clock())),
    ['meetingId', 'id', 'kind', 'askedBy', 'expiresAt', 'expiresInMs', 'askerVerified', 'question', 'primaryLabel', 'channel'],
  );
});

test('tryOpen says why a request is refused: asked a moment ago, too many open, or not a request', () => {
  const { approvals, advance } = setup({ maxPerMeeting: 2, maxAskersPerMeeting: 3 });
  const first = approvals.tryOpen(M, { kind: 'share_notes', askedByUserId: 'user-ben', askedByName: 'Ben' });
  assert.deepEqual(Object.keys(first), ['ok', 'id', 'expiresAt']);
  assert.equal(first.ok, true);
  assert.equal(approvals.get(M, first.id).id, first.id);
  const again = { kind: 'share_notes', askedByUserId: 'user-ben', askedByName: 'Ben' };
  // has one open
  assert.deepEqual(approvals.tryOpen(M, again), { ok: false, reason: 'too_soon' });
  assert.equal(approvals.open(M, again), null);
  // not a request at all
  assert.deepEqual(approvals.tryOpen(M, { kind: 'nope', askedByUserId: 'user-dee' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(approvals.tryOpen(M, { kind: 'share_notes' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(approvals.tryOpen(M, { kind: 'agent_action' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(approvals.tryOpen('', again), { ok: false, reason: 'invalid' });
  // the meeting has as many open as it takes
  assert.equal(approvals.tryOpen(M, { kind: 'share_notes', askedByUserId: 'user-dee' }).ok, true);
  assert.deepEqual(approvals.tryOpen(M, { kind: 'share_notes', askedByUserId: 'user-eve' }), { ok: false, reason: 'too_many_open' });
  assert.deepEqual(
    approvals.tryOpen(M, { kind: 'agent_action', question: 'Do it?', primaryLabel: 'Do it', channel: 'voice' }),
    { ok: false, reason: 'too_many_open' },
  );
  // someone who asked a moment ago hears that, also while the meeting is full
  assert.deepEqual(approvals.tryOpen(M, again), { ok: false, reason: 'too_soon' });
  // closed, and still within two minutes
  advance(60000);
  assert.deepEqual(approvals.tryOpen(M, again), { ok: false, reason: 'too_soon' });
  // the memory of who asked is full: a cap, not this person's own doing
  assert.equal(approvals.tryOpen(M, { kind: 'share_notes', askedByUserId: 'user-eve' }).ok, true);
  assert.deepEqual(approvals.tryOpen(M, { kind: 'share_notes', askedByUserId: 'user-fay' }), { ok: false, reason: 'too_many_open' });
});
