// A measurement: can a transcript line's speaker be matched to the Arlo user
// whose panel reported who they are in the meeting? Only counters come out.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', MEETING_FLUSH_GRACE_MS: '200', AI_ENABLED: 'false' });

const test = require('node:test');
const assert = require('node:assert/strict');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { getMeetingStore } = require('../src/storage');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');
const { createMeetingStreams } = require('../src/services/meetingStreams');
const { createArloPresence } = require('../src/services/arloPresence');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const ZERO = {
  lines: 0, idEqualsParticipantId: 0, idEqualsParticipantUUID: 0, nameEqualsScreenName: 0, identities: 0,
};

// --- the store -------------------------------------------------------------------

test('the store keeps at most 20 identities per meeting, rebuilt from known fields, and they go with the meeting', () => {
  const store = createMemoryMeetingStore();
  assert.equal(store.setIdentity('M1', 'u1', { screenName: 'A' }), false); // a meeting not held
  assert.equal(store.has('M1'), false);
  store.appendEvent('M1', { eventType: 'transcription_started' });
  assert.deepEqual(store.listIdentities('M1'), []);
  assert.deepEqual(store.getIdentityCheck('unknown'), ZERO);

  for (let i = 0; i < 25; i += 1) {
    assert.equal(store.setIdentity('M1', `u${i}`, { participantId: `p${i}`, extra: 'no' }), i < 20);
  }
  assert.equal(store.getIdentityCheck('M1').identities, 20);
  assert.deepEqual(store.listIdentities('M1')[3], { participantUUID: null, participantId: 'p3', screenName: null });
  // one already held can still be replaced when full; values are trimmed and bounded
  assert.equal(store.setIdentity('M1', 'u3', { participantUUID: `  ${'x'.repeat(500)} `, screenName: ' Ana ' }), true);
  assert.deepEqual(store.listIdentities('M1')[3], { participantUUID: 'x'.repeat(200), participantId: null, screenName: 'Ana' });
  // what is not an identity or not an id is not kept
  for (const [userId, identity] of [['u1', null], ['u1', 'text'], ['u1', []], ['u1', {}], ['u1', { screenName: ' ' }],
    ['u1', { participantId: 5 }], ['', { screenName: 'A' }], [5, { screenName: 'A' }], ['x'.repeat(300), { screenName: 'A' }]]) {
    assert.equal(store.setIdentity('M1', userId, identity), false, JSON.stringify([userId, identity]));
  }
  assert.deepEqual(store.listIdentities('M1')[1], { participantUUID: null, participantId: 'p1', screenName: null });
  // copies are handed out
  store.listIdentities('M1')[1].participantId = 'changed';
  store.getIdentityCheck('M1').lines = 99;
  assert.equal(store.listIdentities('M1')[1].participantId, 'p1');
  assert.equal(store.getIdentityCheck('M1').lines, 0);
  // the meeting's other facts are as they were
  assert.deepEqual(Object.keys(store.getMeta('M1')).sort(), ['notesShared', 'ownerName', 'ownerNames', 'ownerUserId', 'whoCanAsk']);

  store.deleteMeeting('M1');
  assert.deepEqual(store.listIdentities('M1'), []);
  assert.deepEqual(store.getIdentityCheck('M1'), ZERO);
});

test('the store adds to the counters: whole numbers only, and nothing else gets in', () => {
  const store = createMemoryMeetingStore();
  assert.equal(store.addIdentityCheck('M1', { lines: 1 }), false);
  store.appendEvent('M1', { eventType: 'transcription_started' });
  store.addIdentityCheck('M1', { lines: 1, idEqualsParticipantId: 1, somethingElse: 5 });
  store.addIdentityCheck('M1', { lines: 1, nameEqualsScreenName: 1, idEqualsParticipantUUID: -3 });
  for (const bad of [null, 5, [], { lines: '1' }, { lines: 1.5 }, { lines: Infinity }]) store.addIdentityCheck('M1', bad);
  assert.deepEqual(store.getIdentityCheck('M1'), {
    lines: 2, idEqualsParticipantId: 1, idEqualsParticipantUUID: 0, nameEqualsScreenName: 1, identities: 0,
  });
  store.deleteMeeting('M1');
  assert.equal(store.getIdentityCheck('M1').lines, 0);
});

// --- counting (unit) --------------------------------------------------------------

const M = 'MEETING-IDENTITY==';
function setup() {
  const users = { 'zoom-a': { id: 'u-a', displayName: 'Owner One' }, 'zoom-b': { id: 'u-b', displayName: 'Owner Two' } };
  const store = createMemoryMeetingStore();
  const streams = createMeetingStreams({ log: { warn() {} } });
  const presence = createArloPresence({
    store, streams, findUserByZoomId: (zoomUserId) => users[zoomUserId] || null, streamStatus: () => 'rtms_started',
  });
  const start = (streamId, operatorId) => {
    streams.streamStarted(M, { streamId, operatorId });
    store.appendEvent(M, { eventType: 'transcription_started' });
  };
  return { store, presence, start };
}

test('only an owner\'s identity is kept', () => {
  const { presence, start } = setup();
  start('s1', 'zoom-a');
  assert.equal(presence.setIdentity(M, 'u-b', { screenName: 'Two' }), false);
  assert.equal(presence.setIdentity(M, null, { screenName: 'Two' }), false);
  assert.equal(presence.setIdentity('OTHER==', 'u-a', { screenName: 'One' }), false);
  assert.equal(presence.setIdentity(M, 'u-a', {}), false);
  assert.equal(presence.setIdentity(M, 'u-a', null), false);
  assert.deepEqual(presence.identityCheck(M), ZERO);
  assert.equal(presence.setIdentity(M, 'u-a', { screenName: 'One' }), true);
  assert.equal(presence.identityCheck(M).identities, 1);
});

test('a stored line is compared with every stored identity, and only counters are kept', () => {
  const { presence, start, store } = setup();
  start('s1', 'zoom-a');
  // nobody reported yet: nothing to compare with, nothing counted
  presence.lineStored(M, { speakerId: '16778240', speakerLabel: 'Owner One' });
  assert.deepEqual(presence.identityCheck(M), ZERO);

  presence.setIdentity(M, 'u-a', { participantUUID: 'UUID-A', participantId: '16778240', screenName: 'Owner One' });
  start('s2', 'zoom-b');
  presence.setIdentity(M, 'u-b', { participantUUID: '555', screenName: 'Second Person' });

  presence.lineStored(M, { speakerId: '16778240', speakerLabel: 'owner ONE ' }); // id = participantId, name whatever the case
  presence.lineStored(M, { speakerId: ' 555 ', speakerLabel: 'Somebody' }); // id = the other owner's participantUUID
  presence.lineStored(M, { speakerId: '9', speakerLabel: 'Second Person' }); // name only
  presence.lineStored(M, { speakerId: '16778240x', speakerLabel: 'Owner' }); // nothing: no partial matches
  presence.lineStored(M, { speakerId: 'unknown', speakerLabel: 'Speaker' });
  // not a line: ignored
  for (const bad of [null, undefined, 'line', 5, {}, { speakerId: 5, speakerLabel: {} }]) presence.lineStored(M, bad);

  assert.deepEqual(presence.identityCheck(M), {
    lines: 5, idEqualsParticipantId: 1, idEqualsParticipantUUID: 1, nameEqualsScreenName: 2, identities: 2,
  });
  // a meeting not held counts nothing and holds nothing
  presence.lineStored('OTHER==', { speakerId: '16778240', speakerLabel: 'Owner One' });
  assert.deepEqual(presence.identityCheck('OTHER=='), ZERO);

  store.deleteMeeting(M);
  assert.deepEqual(presence.identityCheck(M), ZERO);
});

// --- the routes -------------------------------------------------------------------

const internal = { 'x-arlo-internal-key': h.internalKey() };
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
const say = (meetingId, speakerId, speakerLabel, text = 'a line') => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, streamId: 's1', segment: { seqNo: 1, text, speakerId, speakerLabel, tStartMs: Date.now(), tEndMs: Date.now() } },
  internal,
);
let people = 0;
function person(displayName) {
  people += 1;
  const zoomUserId = `zoom-identity-${people}`;
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
const url = (meetingId, path) => `${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/arlo/${path}`;
const cookie = (pass, who) => [pass, who?.session].filter(Boolean).join('; ');
async function report(meetingId, who, pass, body, contentType = 'application/json') {
  const res = await fetch(url(meetingId, 'identity'), {
    method: 'POST',
    headers: { 'content-type': contentType, cookie: cookie(pass, who) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), cache: res.headers.get('cache-control') };
}
async function check(meetingId, who, pass) {
  const res = await fetch(url(meetingId, 'identity-check'), { headers: { cookie: cookie(pass, who) } });
  return { status: res.status, body: await res.json().catch(() => null), cache: res.headers.get('cache-control') };
}

test('an owner reports who they are in the meeting, and reads the counters: no ids or names come back', async () => {
  const meeting = 'IDENTITY-1==';
  const owner = person('Owner One');
  const pass = await access(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: owner.zoomUserId });

  await say(meeting, '16778240', 'Owner One'); // before the report: not counted
  const res = await report(meeting, owner, pass, { participantUUID: 'UUID-SECRET-1', participantId: '16778240', screenName: ' Owner One ' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { stored: true });
  assert.equal(res.cache, 'no-store');

  await say(meeting, '16778240', 'Owner One');
  await say(meeting, '16778240', 'Owner One', 'another line');
  await say(meeting, '4', 'Somebody Else', 'a third line');

  const read = await check(meeting, owner, pass);
  assert.equal(read.status, 200);
  assert.equal(read.cache, 'no-store');
  assert.deepEqual(read.body, {
    lines: 3, idEqualsParticipantId: 2, idEqualsParticipantUUID: 0, nameEqualsScreenName: 2, identities: 1,
  });
  assert.equal(/UUID-SECRET-1|16778240|Owner One/.test(JSON.stringify(read.body)), false);
});

test('the report and the counters are for owners of this meeting only', async () => {
  const meeting = 'IDENTITY-2==';
  const owner = person('Owner One');
  const other = person('Someone Else'); // signed in, in the meeting, not an owner
  const pass = await access(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: owner.zoomUserId });
  const body = { participantId: '7' };

  assert.equal((await report(meeting, other, pass, body)).status, 403);
  assert.equal((await report(meeting, null, pass, body)).status, 401);
  assert.equal((await report(meeting, owner, await access('IDENTITY-OTHER=='), body)).status, 403);
  assert.equal((await report(meeting, owner, '', body)).status, 401); // no meeting-access cookie
  assert.equal((await check(meeting, other, pass)).status, 403);
  assert.equal((await check(meeting, null, pass)).status, 401);
  assert.equal((await check(meeting, owner, await access('IDENTITY-OTHER=='))).status, 403);
  assert.equal(getMeetingStore().getIdentityCheck(meeting).identities, 0);
});

test('a report is refused unless it is exactly the known fields, each a sane string', async () => {
  const meeting = 'IDENTITY-3==';
  const owner = person('Owner One');
  const pass = await access(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: owner.zoomUserId });

  const bad = [
    {}, [], { participantId: '' }, { participantId: '   ' }, { participantId: 7 }, { participantId: null },
    { participantId: ['7'] }, { participantId: { id: '7' } }, { participantUUID: true }, { screenName: 'x'.repeat(201) },
    { screenName: 'A\nB' }, { screenName: 'A\u0000' }, { participantId: '7\u001b' }, { participantUUID: 'a\u007f' }, { screenName: 'A\u0085' },
    { participantId: '7', extra: 1 }, { participantId: '7', userId: 'someone' }, { participantId: '7', screenName: '' },
  ];
  for (const body of bad) {
    assert.equal((await report(meeting, owner, pass, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await report(meeting, owner, pass, 'participantId=7', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal(getMeetingStore().getIdentityCheck(meeting).identities, 0);

  // each alone is enough, and 200 characters is the most
  for (const body of [{ participantId: '7' }, { participantUUID: 'abc' }, { screenName: 'x'.repeat(200) }]) {
    assert.equal((await report(meeting, owner, pass, body)).status, 200, JSON.stringify(body));
  }
  assert.equal(getMeetingStore().getIdentityCheck(meeting).identities, 1);
});

test('identities and counters go when the meeting\'s data is flushed', async () => {
  const meeting = 'IDENTITY-4==';
  const owner = person('Owner One');
  const pass = await access(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: owner.zoomUserId });
  await report(meeting, owner, pass, { participantId: '7' });
  await say(meeting, '7', 'Owner One');
  assert.equal((await check(meeting, owner, pass)).body.idEqualsParticipantId, 1);

  await status(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  await h.wait(50);
  assert.equal(getMeetingStore().has(meeting), false);
  assert.equal(getMeetingStore().getIdentityCheck(meeting).identities, 0);
  assert.equal(getMeetingStore().getIdentityCheck(meeting).lines, 0);
  // nobody owns a meeting that is gone
  assert.equal((await check(meeting, owner, pass)).status, 403);
  assert.equal((await report(meeting, owner, pass, { participantId: '7' })).status, 403);
});

test('nothing about an identity is logged', async () => {
  const meeting = 'IDENTITY-5==';
  const owner = person('Owner One');
  const pass = await access(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: owner.zoomUserId });
  const seen = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const level of Object.keys(real)) console[level] = (...args) => seen.push(args.map(String).join(' '));
  try {
    await report(meeting, owner, pass, { participantUUID: 'UUID-SECRET-5', participantId: '98765432', screenName: 'Quiet Name' });
    await say(meeting, '98765432', 'Quiet Name');
    await check(meeting, owner, pass);
  } finally {
    Object.assign(console, real);
  }
  assert.equal(/UUID-SECRET-5|98765432|Quiet Name/.test(seen.join('\n')), false);
});
