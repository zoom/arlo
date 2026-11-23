// Who brought Arlo in (the "owners" of a meeting's notes) and what one panel
// is told about Arlo in its meeting.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');
const { createMeetingStreams } = require('../src/services/meetingStreams');
const { createArloPresence } = require('../src/services/arloPresence');

const M = 'MEETING-1==';
// Arlo users by their Zoom user id. zoom-guest has never signed in to Arlo.
const USERS = {
  'zoom-ana': { id: 'u-ana', displayName: 'Ana Ruiz' },
  'zoom-ben': { id: 'u-ben', displayName: 'Ben Okafor' },
  'zoom-noname': { id: 'u-noname' },
};

function setup() {
  const store = createMemoryMeetingStore();
  const streams = createMeetingStreams({ log: { warn() {} } });
  const status = {};
  const presence = createArloPresence({
    store,
    streams,
    findUserByZoomId: (zoomUserId) => USERS[zoomUserId] || null,
    streamStatus: (meetingId) => status[meetingId] || null,
  });
  // What the status route does when a stream starts
  const start = (streamId, operatorId, originalHost = false) => {
    streams.streamStarted(M, { streamId, operatorId, originalHost });
    store.appendEvent(M, { eventType: 'transcription_started' });
    status[M] = 'rtms_started';
  };
  return { store, streams, status, presence, start };
}

test('the operator of the stream, when an Arlo user, is the owner', () => {
  const { presence, start } = setup();
  start('s1', 'zoom-ana');

  assert.deepEqual(presence.ownerUserIds(M), ['u-ana']);
  assert.equal(presence.isOwner(M, 'u-ana'), true);
  assert.equal(presence.isOwner(M, 'u-ben'), false);
  assert.deepEqual(presence.stateFor(M, 'u-ana'), {
    present: true, paused: false, role: 'owner', ownerName: 'Ana Ruiz', whoCanAsk: 'owner',
  });
});

test('everyone else, signed in or not, is a participant', () => {
  const { presence, start } = setup();
  start('s1', 'zoom-ana');
  const participant = {
    present: true, paused: false, role: 'participant', ownerName: 'Ana Ruiz', whoCanAsk: 'owner',
  };
  assert.deepEqual(presence.stateFor(M, 'u-ben'), participant);
  assert.deepEqual(presence.stateFor(M, null), participant);
  assert.deepEqual(presence.stateFor(M, undefined), participant);
  assert.equal(presence.isOwner(M, null), false);
  assert.equal(presence.isOwner(M, undefined), false);
});

test('an operator who is not an Arlo user adds no owner', () => {
  const { presence, start } = setup();
  start('s1', 'zoom-guest');
  assert.deepEqual(presence.ownerUserIds(M), []);
  assert.deepEqual(presence.stateFor(M, 'u-ana'), {
    present: true, paused: false, role: 'participant', ownerName: null, whoCanAsk: 'owner',
  });
  // the Zoom id itself is never an Arlo user id
  assert.equal(presence.isOwner(M, 'zoom-guest'), false);
  assert.equal(presence.isOwner(M, 'zoom-ana'), false);
});

test('a stream with no operator known adds no owner', () => {
  const { presence, start } = setup();
  start('s1', undefined);
  assert.deepEqual(presence.ownerUserIds(M), []);
});

test('a second stream by another Arlo user makes two owners', () => {
  const { presence, start } = setup();
  start('s1', 'zoom-ana');
  start('s2', 'zoom-ben');
  assert.deepEqual(presence.ownerUserIds(M), ['u-ana', 'u-ben']);
  assert.equal(presence.stateFor(M, 'u-ana').role, 'owner');
  assert.equal(presence.stateFor(M, 'u-ben').role, 'owner');
  // the name shown is of the primary stream: the one that started first
  assert.equal(presence.stateFor(M, 'u-ben').ownerName, 'Ana Ruiz');
});

test('the name shown is the original host\'s when their stream exists', () => {
  const { presence, start } = setup();
  start('s1', 'zoom-ana');
  start('s2', 'zoom-ben', true);
  assert.equal(presence.stateFor(M, null).ownerName, 'Ben Okafor');
  assert.deepEqual(presence.ownerUserIds(M), ['u-ben', 'u-ana']);
});

test('when the primary stream\'s operator is not an Arlo user, the first owner\'s name is shown', () => {
  const { presence, start } = setup();
  start('s1', 'zoom-guest', true);
  start('s2', 'zoom-ben');
  assert.equal(presence.stateFor(M, null).ownerName, 'Ben Okafor');
});

test('an owner without a usable name is still an owner; the name is null or cut', () => {
  const { presence, start } = setup();
  start('s1', 'zoom-noname');
  assert.equal(presence.stateFor(M, 'u-noname').role, 'owner');
  assert.equal(presence.stateFor(M, 'u-noname').ownerName, null);

  const long = createArloPresence({
    store: (() => { const s = createMemoryMeetingStore(); s.appendEvent(M, { eventType: 'x' }); return s; })(),
    streams: (() => { const s = createMeetingStreams(); s.streamStarted(M, { streamId: 's1', operatorId: 'z' }); return s; })(),
    findUserByZoomId: () => ({ id: 'u1', displayName: 'n'.repeat(500) }),
    streamStatus: () => 'rtms_started',
  });
  assert.equal(long.stateFor(M, 'u1').ownerName.length, 200);
});

test('a user stays an owner after their stream stops, and present and paused follow the stream', () => {
  const { presence, start, streams, status } = setup();
  start('s1', 'zoom-ana');
  status[M] = 'rtms_paused';
  assert.deepEqual(
    [presence.stateFor(M, 'u-ana').present, presence.stateFor(M, 'u-ana').paused],
    [true, true],
  );
  status[M] = 'rtms_interrupted'; // reconnecting: Arlo is still in the meeting
  assert.deepEqual(
    [presence.stateFor(M, 'u-ana').present, presence.stateFor(M, 'u-ana').paused],
    [true, false],
  );

  streams.streamStopped(M, 's1');
  delete status[M];
  assert.deepEqual(presence.stateFor(M, 'u-ana'), {
    present: false, paused: false, role: 'owner', ownerName: 'Ana Ruiz', whoCanAsk: 'owner',
  });
});

test('any owner may change who can ask; nobody else can, and only to a known value', () => {
  const { presence, start } = setup();
  start('s1', 'zoom-ana');
  start('s2', 'zoom-ben');

  assert.equal(presence.setWhoCanAsk(M, 'u-ana', 'anyone'), true);
  assert.equal(presence.stateFor(M, null).whoCanAsk, 'anyone');
  assert.equal(presence.setWhoCanAsk(M, 'u-ben', 'owner'), true);
  assert.equal(presence.stateFor(M, null).whoCanAsk, 'owner');

  for (const notOwner of ['u-noname', 'zoom-ana', null, undefined, '', 42]) {
    assert.equal(presence.setWhoCanAsk(M, notOwner, 'anyone'), false);
  }
  for (const bad of ['everyone', '', null, undefined, true, ['anyone'], { value: 'anyone' }]) {
    assert.equal(presence.setWhoCanAsk(M, 'u-ana', bad), false);
  }
  assert.equal(presence.stateFor(M, null).whoCanAsk, 'owner');
  assert.equal(presence.setWhoCanAsk('OTHER==', 'u-ana', 'anyone'), false);
});

test('once the meeting\'s data is deleted there is no owner, and the setting is back to its default', () => {
  const { presence, start, store, status } = setup();
  start('s1', 'zoom-ana');
  presence.setWhoCanAsk(M, 'u-ana', 'anyone');
  store.deleteMeeting(M);
  delete status[M];

  assert.deepEqual(presence.ownerUserIds(M), []);
  assert.equal(presence.isOwner(M, 'u-ana'), false);
  assert.equal(presence.setWhoCanAsk(M, 'u-ana', 'anyone'), false);
  assert.deepEqual(presence.stateFor(M, 'u-ana'), {
    present: false, paused: false, role: 'participant', ownerName: null, whoCanAsk: 'owner',
  });
});

test('a meeting nothing is known about has no Arlo, no owner and the default setting', () => {
  const { presence } = setup();
  const nothing = { present: false, paused: false, role: 'participant', ownerName: null, whoCanAsk: 'owner' };
  assert.deepEqual(presence.stateFor('UNKNOWN==', 'u-ana'), nothing);
  assert.deepEqual(presence.stateFor(42, 'u-ana'), nothing);
  assert.deepEqual(presence.ownerUserIds('UNKNOWN=='), []);
});

test('a user lookup that throws or returns nonsense adds no owner', () => {
  const store = createMemoryMeetingStore();
  const streams = createMeetingStreams();
  streams.streamStarted(M, { streamId: 's1', operatorId: 'zoom-a' });
  streams.streamStarted(M, { streamId: 's2', operatorId: 'zoom-b' });
  streams.streamStarted(M, { streamId: 's3', operatorId: 'zoom-c' });
  store.appendEvent(M, { eventType: 'x' });
  const answers = { 'zoom-b': { id: 42, displayName: 'No id' }, 'zoom-c': 'a string' };
  const presence = createArloPresence({
    store,
    streams,
    findUserByZoomId: (zoomUserId) => { if (zoomUserId === 'zoom-a') throw new Error('store down'); return answers[zoomUserId]; },
    streamStatus: () => 'rtms_started',
  });
  assert.deepEqual(presence.ownerUserIds(M), []);
  assert.equal(presence.stateFor(M, 42).role, 'participant');
});
