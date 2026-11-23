// The meeting store also holds a meeting's notes and a few facts about it
// (who brought Arlo in, who may ask). They live and die with the transcript.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');

const withMeeting = (options) => {
  const store = createMemoryMeetingStore(options);
  store.appendSegment('M1', { text: 'We ship on Friday.' });
  return store;
};
const notes = (overrides = {}) => ({
  summary: 'The team agreed to ship on Friday.',
  decisions: ['Ship on Friday'],
  actionItems: [{ text: 'Write the release note', owner: 'Ana' }, { text: 'Book the room', owner: null }],
  throughSeqNo: 1,
  ...overrides,
});

test('notes are stored and returned with the time they were written', () => {
  const store = withMeeting({ now: () => 7000 });
  const expected = {
    summary: 'The team agreed to ship on Friday.',
    decisions: ['Ship on Friday'],
    actionItems: [{ text: 'Write the release note', owner: 'Ana' }, { text: 'Book the room', owner: null }],
    updatedAt: 7000,
    throughSeqNo: 1,
  };
  assert.deepEqual(store.setNotes('M1', notes()), expected);
  assert.deepEqual(store.getNotes('M1'), expected);
});

test('there are no notes before any were stored, or for a meeting not held', () => {
  const store = withMeeting();
  assert.equal(store.getNotes('M1'), null);
  assert.equal(store.getNotes('unknown'), null);
});

test('long values are cut and long lists are shortened', () => {
  const store = withMeeting();
  const stored = store.setNotes('M1', notes({
    summary: 's'.repeat(5000),
    decisions: Array.from({ length: 50 }, () => 'd'.repeat(1000)),
    actionItems: Array.from({ length: 80 }, () => ({ text: 't'.repeat(1000), owner: 'o'.repeat(1000) })),
  }));
  assert.equal(stored.summary.length, 1500);
  assert.equal(stored.decisions.length, 20);
  assert.ok(stored.decisions.every((d) => d.length === 300));
  assert.equal(stored.actionItems.length, 30);
  assert.ok(stored.actionItems.every((a) => a.text.length === 300 && a.owner.length === 200));
});

test('unknown fields are dropped, and so are list entries of the wrong shape', () => {
  const store = withMeeting({ now: () => 7000 });
  // As it arrives from JSON: "__proto__" and "constructor" are own keys
  const raw = JSON.parse('{"summary":"ok","decisions":["kept",7,null,"",{"a":1}],'
    + '"actionItems":[{"text":"kept","owner":5,"extra":"x","__proto__":{"polluted":true}},{"owner":"no text"},"string",null,{"text":""}],'
    + '"throughSeqNo":3,"updatedAt":1,"extra":"dropped","__proto__":{"polluted":true},"constructor":"c"}');
  const stored = store.setNotes('M1', raw);

  assert.deepEqual(stored, {
    summary: 'ok', decisions: ['kept'], actionItems: [{ text: 'kept', owner: null }], updatedAt: 7000, throughSeqNo: 3,
  });
  assert.equal(Object.getPrototypeOf(stored), Object.prototype);
  assert.equal(Object.getPrototypeOf(stored.actionItems[0]), Object.prototype);
  assert.equal(stored.polluted, undefined);
});

test('lists that are missing or not lists become empty', () => {
  const store = withMeeting();
  const stored = store.setNotes('M1', { summary: '', decisions: 'not a list', throughSeqNo: 0 });
  assert.deepEqual(stored.decisions, []);
  assert.deepEqual(stored.actionItems, []);
  assert.equal(stored.summary, '');
});

test('notes without a text summary or a sane sequence number are refused, and the old notes stay', () => {
  const store = withMeeting();
  store.setNotes('M1', notes());
  for (const bad of [null, 'text', 7, [], notes({ summary: 7 }), notes({ summary: undefined }),
    notes({ throughSeqNo: -1 }), notes({ throughSeqNo: 1.5 }), notes({ throughSeqNo: '1' }),
    notes({ throughSeqNo: 2 ** 31 }), notes({ throughSeqNo: undefined })]) {
    assert.equal(store.setNotes('M1', bad), null);
  }
  assert.equal(store.getNotes('M1').summary, 'The team agreed to ship on Friday.');
});

test('notes and meta for a meeting the store does not hold are refused and create nothing', () => {
  const store = createMemoryMeetingStore();
  assert.equal(store.setNotes('GONE', notes()), null);
  assert.equal(store.setMeta('GONE', { whoCanAsk: 'anyone' }), null);
  assert.equal(store.setNotes('', notes()), null);
  assert.equal(store.setMeta(42, { whoCanAsk: 'anyone' }), null);
  assert.equal(store.has('GONE'), false);
  assert.equal(store.size(), 0);
});

test('a timeline event is enough for a meeting to exist', () => {
  const store = createMemoryMeetingStore();
  store.appendEvent('M1', { eventType: 'transcription_started' });
  assert.equal(store.setNotes('M1', notes()).throughSeqNo, 1);
  assert.equal(store.setMeta('M1', { ownerUserId: 'u1' }).ownerUserId, 'u1');
});

test('meta has defaults, for a meeting that is held and for one that is not', () => {
  const store = withMeeting();
  const defaults = { ownerUserId: null, ownerName: null, whoCanAsk: 'owner', ownerNames: new Map() };
  assert.deepEqual(store.getMeta('M1'), defaults);
  assert.deepEqual(store.getMeta('unknown'), defaults);
});

test('meta is changed one known field at a time', () => {
  const store = withMeeting();
  assert.deepEqual(
    store.setMeta('M1', { ownerUserId: 'u1', ownerName: 'Ana' }),
    { ownerUserId: 'u1', ownerName: 'Ana', whoCanAsk: 'owner', ownerNames: new Map() },
  );
  assert.deepEqual(
    store.setMeta('M1', { whoCanAsk: 'anyone' }),
    { ownerUserId: 'u1', ownerName: 'Ana', whoCanAsk: 'anyone', ownerNames: new Map() },
  );
  assert.deepEqual(
    store.setMeta('M1', { ownerUserId: null, ownerName: null }),
    { ownerUserId: null, ownerName: null, whoCanAsk: 'anyone', ownerNames: new Map() },
  );
  assert.equal(store.setMeta('M1', { ownerName: 'n'.repeat(500) }).ownerName.length, 200);
});

test('meta ignores unknown keys and bad values instead of storing them', () => {
  const store = withMeeting();
  store.setMeta('M1', { ownerUserId: 'u1', ownerName: 'Ana', whoCanAsk: 'anyone' });
  const raw = JSON.parse('{"whoCanAsk":"everyone","ownerUserId":7,"ownerName":{"a":1},"admin":true,"__proto__":{"polluted":true}}');
  const meta = store.setMeta('M1', raw);

  assert.deepEqual(meta, { ownerUserId: 'u1', ownerName: 'Ana', whoCanAsk: 'anyone', ownerNames: new Map() });
  assert.equal(meta.polluted, undefined);
  assert.deepEqual(store.setMeta('M1', { ownerUserId: 'x'.repeat(257) }), meta); // an id is never cut: too long is not that id
  assert.deepEqual(store.setMeta('M1', { ownerUserId: '' }), meta);
  for (const bad of [null, 'text', 7, []]) assert.deepEqual(store.setMeta('M1', bad), meta);
});

test('deleting a meeting removes its notes and meta', () => {
  const store = withMeeting();
  store.setNotes('M1', notes());
  store.setMeta('M1', { ownerUserId: 'u1', ownerName: 'Ana', whoCanAsk: 'anyone' });

  assert.equal(store.deleteMeeting('M1'), true);
  assert.equal(store.getNotes('M1'), null);
  assert.deepEqual(store.getMeta('M1'), { ownerUserId: null, ownerName: null, whoCanAsk: 'owner', ownerNames: new Map() });

  // The same meeting id again starts clean
  store.appendSegment('M1', { text: 'A new stream.' });
  assert.equal(store.getNotes('M1'), null);
  assert.equal(store.getMeta('M1').ownerUserId, null);
});

test('the age limit removes notes and meta with the rest', () => {
  const clock = { now: 0 };
  const store = withMeeting({ now: () => clock.now, maxAgeMs: 1000 });
  store.setNotes('M1', notes());
  store.setMeta('M1', { ownerUserId: 'u1' });
  clock.now = 1100;

  assert.equal(store.sweep(), 1);
  assert.equal(store.getNotes('M1'), null);
  assert.equal(store.getMeta('M1').ownerUserId, null);
});

test('everything returned is a copy: callers cannot change the stored notes or meta', () => {
  const store = withMeeting();
  const input = notes();
  const written = store.setNotes('M1', input);
  input.decisions.push('added to the input afterwards');
  input.actionItems[0].text = 'changed in the input';
  written.summary = 'changed through the result';
  written.decisions.push('injected');
  written.actionItems[0].owner = 'changed';
  const read = store.getNotes('M1');
  read.actionItems.pop();
  read.actionItems[0].text = 'changed through a read';

  assert.deepEqual(store.getNotes('M1'), {
    ...notes(), updatedAt: store.getNotes('M1').updatedAt,
  });

  const meta = store.setMeta('M1', { ownerName: 'Ana' });
  meta.ownerName = 'changed through the result';
  store.getMeta('M1').whoCanAsk = 'anyone';
  assert.deepEqual(store.getMeta('M1'), { ownerUserId: null, ownerName: 'Ana', whoCanAsk: 'owner', ownerNames: new Map() });
});

test('writing notes does not count as the meeting being written to', () => {
  // A late model answer must not keep an idle meeting ahead of one still in use
  const store = createMemoryMeetingStore({ maxMeetings: 2 });
  store.appendSegment('IDLE', { text: 'x' });
  store.appendSegment('LIVE', { text: 'x' });
  store.setNotes('IDLE', notes());
  store.appendSegment('NEW', { text: 'x' });
  assert.equal(store.has('IDLE'), false);
  assert.equal(store.has('LIVE'), true);
});
