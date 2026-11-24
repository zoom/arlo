// What Arlo was asked and did, kept with the meeting: appendAction,
// updateAction, listActions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');
const { ALL_TOOL_NAMES } = require('../src/services/agent/tools');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const M = 'MEETING-ACTIONS==';

function held(options) {
  let clock = 1000;
  const store = createMemoryMeetingStore({ now: () => clock, ...options });
  store.appendSegment(M, { text: 'hello' });
  return { store, tick: (ms) => { clock += ms; } };
}
const ACTION = { tool: 'summarize_so_far', label: 'Summarized the meeting so far', askedBy: 'Priya', channel: 'voice', status: 'pending', public: true };

test('an action is stored with an id and a time, rebuilt from known fields', () => {
  const { store } = held();
  assert.deepEqual(store.listActions(M), []);
  const stored = store.appendAction(M, { ...ACTION, somethingElse: 'x', id: 'chosen-by-caller', args: { message: 'secret' } });
  assert.match(stored.id, UUID);
  assert.deepEqual(stored, {
    id: stored.id, at: 1000, tool: 'summarize_so_far', label: 'Summarized the meeting so far', askedBy: 'Priya', channel: 'voice', status: 'pending', public: true,
  });
  assert.deepEqual(store.listActions(M), [stored]);
  // a time given is kept when it is one
  assert.equal(store.appendAction(M, { ...ACTION, at: 5000 }).at, 5000);
  assert.equal(store.appendAction(M, { ...ACTION, at: 'now' }).at, 1000);
  assert.equal(store.appendAction(M, { ...ACTION, at: -1 }).at, 1000);
});

test('defaults: pending, not public, asked by nobody', () => {
  const { store } = held();
  const stored = store.appendAction(M, { tool: 'share_notes', label: 'Shared the notes in chat', channel: 'panel' });
  assert.deepEqual([stored.status, stored.public, stored.askedBy], ['pending', false, null]);
  // only true is public
  for (const value of ['true', 1, 'yes', {}, null]) assert.equal(store.appendAction(M, { ...ACTION, public: value }).public, false);
  // a name that is not one is no name
  for (const askedBy of ['', '   ', 5, {}, '\u200b', 'A\u202eB']) assert.equal(store.appendAction(M, { ...ACTION, askedBy }).askedBy, null, JSON.stringify(askedBy));
});

test('every tool in the table can be recorded, also one a deployment has turned off; nothing else', () => {
  const { store } = held();
  for (const tool of ALL_TOOL_NAMES) assert.equal(store.appendAction(M, { ...ACTION, tool }).tool, tool);
  for (const tool of ['delete_everything', 'toString', '__proto__', '', null, undefined, 5, ['share_notes']]) {
    assert.equal(store.appendAction(M, { ...ACTION, tool }), null, JSON.stringify(tool));
  }
  assert.equal(store.listActions(M).length, ALL_TOOL_NAMES.length);
  // a request no tool was found for (the model that picks failed) is recorded under 'none'
  assert.equal(store.appendAction(M, { ...ACTION, tool: 'none' }).tool, 'none');
});

test('an action with a bad channel, status or label, or one that is not an object, is refused', () => {
  const { store } = held();
  const bad = [
    null, undefined, 'action', 5, [], [ACTION],
    { ...ACTION, channel: 'chat' }, { ...ACTION, channel: undefined }, { ...ACTION, channel: 5 },
    { ...ACTION, status: 'finished' }, { ...ACTION, status: 5 }, { ...ACTION, status: null },
    { ...ACTION, label: '' }, { ...ACTION, label: '   ' }, { ...ACTION, label: 5 }, { ...ACTION, label: undefined }, { ...ACTION, label: '\n\u0000\t' },
  ];
  for (const action of bad) assert.equal(store.appendAction(M, action), null, JSON.stringify(action));
  assert.deepEqual(store.listActions(M), []);
  for (const status of ['pending', 'waiting_approval', 'done', 'declined', 'failed', 'expired']) {
    assert.equal(store.appendAction(M, { ...ACTION, status }).status, status);
  }
  for (const channel of ['voice', 'panel']) assert.equal(store.appendAction(M, { ...ACTION, channel }).channel, channel);
});

test('labels and names are bounded and cleaned', () => {
  const { store } = held();
  const stored = store.appendAction(M, { ...ACTION, label: `  Admitted\u0000 Priya\nfrom the\u202e waiting room ${'x'.repeat(500)}`, askedBy: `  ${'n'.repeat(500)} ` });
  assert.equal(stored.label.length, 200);
  assert.ok(stored.label.startsWith('Admitted Priya from the waiting room xxx'));
  assert.equal(stored.askedBy.length, 200);
});

test('a meeting the store does not hold takes no action, and is not created by one', () => {
  const store = createMemoryMeetingStore();
  assert.equal(store.appendAction('NOT-HELD==', ACTION), null);
  assert.equal(store.has('NOT-HELD=='), false);
  assert.deepEqual(store.listActions('NOT-HELD=='), []);
  assert.equal(store.updateAction('NOT-HELD==', 'some-id', { status: 'done' }), null);
  for (const meetingId of [null, undefined, 5, '', {}]) assert.equal(store.appendAction(meetingId, ACTION), null);
});

test('at most 500 actions per meeting: more are refused, and the first ones stay', () => {
  const { store } = held({ maxActionsPerMeeting: 3 });
  const first = store.appendAction(M, ACTION);
  store.appendAction(M, ACTION);
  store.appendAction(M, ACTION);
  assert.equal(store.appendAction(M, ACTION), null);
  assert.equal(store.listActions(M).length, 3);
  assert.equal(store.listActions(M)[0].id, first.id);

  const big = held();
  for (let i = 0; i < 500; i += 1) assert.notEqual(big.store.appendAction(M, ACTION), null);
  assert.equal(big.store.appendAction(M, ACTION), null);
  assert.equal(big.store.listActions(M).length, 500);
});

test('an update changes the status and the label, and nothing else', () => {
  const { store, tick } = held();
  const stored = store.appendAction(M, { ...ACTION, status: 'waiting_approval' });
  tick(500);
  const running = store.updateAction(M, stored.id, { status: 'pending' });
  assert.deepEqual(running, { ...stored, status: 'pending' });
  const done = store.updateAction(M, stored.id, {
    status: 'done', label: '  Posted to chat ', tool: 'post_to_chat', askedBy: 'Someone Else', channel: 'panel', public: false, id: 'x', at: 1,
  });
  assert.deepEqual(done, { ...stored, status: 'done', label: 'Posted to chat' });
  assert.deepEqual(store.listActions(M), [done]);
  // the label alone
  const other = store.appendAction(M, ACTION);
  assert.equal(store.updateAction(M, other.id, { label: 'Answered a question' }).label, 'Answered a question');
  assert.equal(store.listActions(M)[1].status, 'pending');
});

test('an update with a bad value, nothing to change, or an unknown id is refused whole', () => {
  const { store } = held();
  const stored = store.appendAction(M, ACTION);
  const bad = [
    null, undefined, 'done', [], {}, { tool: 'post_to_chat' },
    { status: 'finished' }, { status: 5 }, { status: null }, { label: '' }, { label: '  ' }, { label: 5 },
    { status: 'done', label: '' }, { status: 'finished', label: 'Posted to chat' },
  ];
  for (const patch of bad) assert.equal(store.updateAction(M, stored.id, patch), null, JSON.stringify(patch));
  assert.deepEqual(store.listActions(M), [stored]);
  for (const id of ['unknown', '', null, undefined, 5, {}]) assert.equal(store.updateAction(M, id, { status: 'done' }), null);
  assert.equal(store.updateAction('OTHER==', stored.id, { status: 'done' }), null);
});

test('an action that ended stays as it ended', () => {
  const { store } = held();
  for (const ended of ['done', 'declined', 'failed', 'expired']) {
    const stored = store.appendAction(M, ACTION);
    assert.equal(store.updateAction(M, stored.id, { status: ended }).status, ended);
    assert.equal(store.updateAction(M, stored.id, { status: 'pending' }), null);
    assert.equal(store.updateAction(M, stored.id, { status: 'done', label: 'Posted to chat' }), null);
    assert.equal(store.updateAction(M, stored.id, { label: 'Something else' }), null);
    assert.equal(store.listActions(M).at(-1).status, ended);
    assert.equal(store.listActions(M).at(-1).label, ACTION.label);
  }
});

test('what is returned is a copy', () => {
  const { store } = held();
  const stored = store.appendAction(M, ACTION);
  stored.label = 'changed';
  store.listActions(M)[0].status = 'done';
  store.listActions(M).push({ id: 'x' });
  store.updateAction(M, stored.id, { status: 'waiting_approval' }).label = 'changed too';
  assert.deepEqual(store.listActions(M).map((one) => [one.label, one.status]), [[ACTION.label, 'waiting_approval']]);
});

test('actions go with the meeting: deleted, swept, and not there in the next one', () => {
  let clock = 0;
  const store = createMemoryMeetingStore({ now: () => clock, maxAgeMs: 1000 });
  store.appendSegment(M, { text: 'hello' });
  const stored = store.appendAction(M, ACTION);
  store.deleteMeeting(M);
  assert.deepEqual(store.listActions(M), []);
  assert.equal(store.updateAction(M, stored.id, { status: 'done' }), null);
  // the same meeting id again starts empty
  store.appendSegment(M, { text: 'hello again' });
  assert.deepEqual(store.listActions(M), []);
  store.appendAction(M, ACTION);
  clock = 5000;
  assert.equal(store.sweep(), 1);
  assert.deepEqual(store.listActions(M), []);
});

test('recording an action does not touch the meeting\'s lines or their numbering', () => {
  const store = createMemoryMeetingStore({ maxMeetings: 2 });
  store.appendSegment('A', { text: 'one' });
  store.appendSegment('B', { text: 'two' });
  store.appendAction('A', ACTION);
  assert.equal(store.listSegments('A').length, 1);
  assert.equal(store.appendSegment('A', { text: 'three' }).seqNo, 2);
});
