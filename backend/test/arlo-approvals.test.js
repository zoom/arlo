// The approvals service on its own: a question put to a meeting's owners that
// one of them answers, or that runs out. Time and timers are the test's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApprovals, APPROVAL_KINDS } = require('../src/services/approvals');

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

test('only "share_notes" is a kind for now', () => {
  assert.deepEqual([...APPROVAL_KINDS], ['share_notes']);
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
  for (const kind of ['agent_action', '', null, undefined, 42, 'constructor', '__proto__', ['share_notes']]) {
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
