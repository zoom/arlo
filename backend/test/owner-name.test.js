// The name of the person who brought Arlo in: never a blank, and when the
// account has no name, the name the owner's own panel supplies for the meeting.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', MEETING_FLUSH_GRACE_MS: '200', AI_ENABLED: 'false' });

const test = require('node:test');
const assert = require('node:assert/strict');
const { userStore, clearAll } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { sealSession, RESTORE_COOKIE } = require('../src/services/sessionRestore');
const { getMeetingStore } = require('../src/storage');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');
const { createMeetingStreams } = require('../src/services/meetingStreams');
const { createArloPresence } = require('../src/services/arloPresence');
const { displayNameFrom, cleanName } = require('../src/lib/displayName');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

// --- the account's name -----------------------------------------------------------

test('a display name is built from the parts Zoom gives, and is empty when it gives none', () => {
  assert.equal(displayNameFrom({ first_name: 'Ana', last_name: 'Ruiz' }), 'Ana Ruiz');
  assert.equal(displayNameFrom({ first_name: ' Ana ', last_name: '' }), 'Ana');
  assert.equal(displayNameFrom({ first_name: '', last_name: 'Ruiz' }), 'Ruiz');
  // the access token's payload has no names: not a single space
  assert.equal(displayNameFrom({ first_name: '', last_name: '' }), '');
  assert.equal(displayNameFrom({}), '');
  assert.equal(displayNameFrom({ first_name: undefined, last_name: null }), '');
  assert.equal(displayNameFrom({ first_name: 7, last_name: { a: 1 } }), '');
  assert.equal(displayNameFrom(null), '');
  // Zoom's own display name when it sends no first and last name
  assert.equal(displayNameFrom({ first_name: '', last_name: '', display_name: ' Ana R. ' }), 'Ana R.');
  assert.equal(displayNameFrom({ first_name: 'x'.repeat(300), last_name: 'y' }).length, 200);
});

test('cleanName trims, bounds, and gives an empty string for anything that is not a name', () => {
  assert.equal(cleanName('  Ana  '), 'Ana');
  assert.equal(cleanName(' '), '');
  assert.equal(cleanName('\t\n '), '');
  assert.equal(cleanName(undefined), '');
  assert.equal(cleanName(12), '');
  assert.equal(cleanName('x'.repeat(500)).length, 200);
});

// Characters that show as nothing, or change how the text around them reads
const INVISIBLE = {
  'zero-width space U+200B': '\u200b',
  'soft hyphen U+00AD': '\u00ad',
  'Hangul filler U+3164': '\u3164',
  'Hangul choseong filler U+115F': '\u115f',
  'Hangul jungseong filler U+1160': '\u1160',
  'halfwidth Hangul filler U+FFA0': '\uffa0',
  'right-to-left override U+202E': '\u202e',
  'zero-width joiner U+200D': '\u200d',
  'word joiner U+2060': '\u2060',
  'byte order mark U+FEFF': '\ufeff',
  'line separator U+2028': '\u2028',
  'paragraph separator U+2029': '\u2029',
  'private use U+E000': '\ue000',
  'private use U+F0000': '\u{f0000}',
  'unassigned U+0378': '\u0378',
  'noncharacter U+FFFF': '\uffff',
  'lone surrogate': '\ud83d',
  'control U+0007': '\u0007',
};
const ORDINARY_NAMES = [
  'Ana Ruiz', 'José Ángel Müller', 'Zoë O\'Brien-Smith', 'Nguyễn Thị Minh', '山田 太郎', '王小明', '김민준',
  'محمد علي', 'Дмитрий', 'Ελένη', 'Ana 🎉', '🚀 Ben', 'R2', '7', 'Dr. A.',
];

test('an account name with invisible or unassigned characters, or without a letter or digit, is no name', () => {
  for (const [label, char] of Object.entries(INVISIBLE)) {
    assert.equal(cleanName(char.repeat(3)), '', `only ${label}`);
    assert.equal(cleanName(`An${char}a`), '', `${label} inside a name`);
    assert.equal(displayNameFrom({ first_name: `An${char}a`, last_name: '' }), '', `${label} in a first name`);
    assert.equal(displayNameFrom({ display_name: `An${char}a` }), '', `${label} in a display name`);
  }
  for (const noLetter of ['...', '🎉', '— —', '!!', '\u0301']) assert.equal(cleanName(noLetter), '', JSON.stringify(noLetter));
  for (const name of ORDINARY_NAMES) assert.equal(cleanName(`  ${name} `), name.normalize('NFC'), name);
  // compared and kept in one form: a letter and its combining accent are the one letter
  assert.equal(cleanName('Jose\u0301'), 'José');
  // a good first name is not lost to a bad last name
  assert.equal(displayNameFrom({ first_name: 'Ana', last_name: '\u200b' }), 'Ana');
});

test('a blank name in a restore cookie comes back as an empty string, a real one as it was', async () => {
  for (const [zoomUserId, stored, expected] of [['zoom-name-blank', ' ', ''], ['zoom-name-real', 'Ana Ruiz', 'Ana Ruiz']]) {
    const user = userStore.upsert(zoomUserId, { email: 'a@example.test', displayName: stored, avatarUrl: null });
    const session = generateToken({ userId: user.id, zoomUserId, exp: Date.now() + 60_000 });
    const restore = sealSession({ user, refreshToken: null, scopes: [] });
    clearAll();
    const res = await fetch(`${srv.base}/api/auth/me`, { headers: { cookie: `sessionToken=${session}; ${RESTORE_COOKIE}=${restore}` } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.displayName, expected);
    assert.equal(userStore.findByZoomId(zoomUserId).displayName, expected);
  }
});

// --- what the panels are told (unit) ------------------------------------------------

const M = 'MEETING-NAME==';
function setup(users) {
  const store = createMemoryMeetingStore();
  const streams = createMeetingStreams({ log: { warn() {} } });
  const presence = createArloPresence({
    store, streams, findUserByZoomId: (zoomUserId) => users[zoomUserId] || null, streamStatus: () => 'rtms_started',
  });
  const start = (streamId, operatorId) => {
    streams.streamStarted(M, { streamId, operatorId });
    store.appendEvent(M, { eventType: 'transcription_started' });
  };
  return { store, streams, presence, start };
}

test('an account name that is blank is no name: ownerName is null', () => {
  for (const displayName of [' ', '', '   \t', undefined, null, 42]) {
    const { presence, start } = setup({ 'zoom-a': { id: 'u-a', displayName } });
    start('s1', 'zoom-a');
    assert.equal(presence.stateFor(M, null).ownerName, null, JSON.stringify(displayName));
    assert.equal(presence.stateFor(M, 'u-a').ownerName, null);
  }
  const { presence, start } = setup({ 'zoom-a': { id: 'u-a', displayName: '  Ana Ruiz ' } });
  start('s1', 'zoom-a');
  assert.equal(presence.stateFor(M, null).ownerName, 'Ana Ruiz');
});

test('an owner without an account name can supply one for the meeting; an account name wins', () => {
  const { presence, start, store } = setup({
    'zoom-a': { id: 'u-a', displayName: ' ' }, 'zoom-b': { id: 'u-b', displayName: 'Ben Okafor' }, 'zoom-c': { id: 'u-c' },
  });
  start('s1', 'zoom-a');
  assert.equal(presence.setDisplayName(M, 'u-a', 'Ana (screen)'), 'stored');
  assert.equal(presence.stateFor(M, null).ownerName, 'Ana (screen)');
  // the same again changes nothing
  assert.equal(presence.setDisplayName(M, 'u-a', 'Ana (screen)'), 'unchanged');
  // not an owner: refused, also for someone who is nobody here
  assert.equal(presence.setDisplayName(M, 'u-c', 'Cy'), 'refused');
  assert.equal(presence.setDisplayName(M, null, 'Cy'), 'refused');
  assert.equal(presence.setDisplayName('OTHER==', 'u-a', 'Ana'), 'refused');
  // not a name
  for (const bad of ['', '  ', null, undefined, 7, {}, ['Ana']]) assert.equal(presence.setDisplayName(M, 'u-a', bad), 'refused');

  // an owner whose account has a name: what a panel supplies is not kept
  start('s2', 'zoom-b');
  assert.equal(presence.setDisplayName(M, 'u-b', 'Somebody Else'), 'unchanged');
  assert.equal(store.getMeta(M).ownerNames.has('u-b'), false);
  assert.deepEqual([...store.getMeta(M).ownerNames], [['u-a', 'Ana (screen)']]);
});

test('the meeting store holds at most 20 supplied names, each bounded, and they go with the meeting', () => {
  const store = createMemoryMeetingStore();
  store.appendEvent('M1', { eventType: 'transcription_started' });
  assert.deepEqual([...store.getMeta('M1').ownerNames], []);
  assert.deepEqual([...store.getMeta('unknown').ownerNames], []);
  for (let i = 0; i < 25; i += 1) store.setMeta('M1', { ownerNameFor: { userId: `u${i}`, name: `Name ${i}` } });
  assert.equal(store.getMeta('M1').ownerNames.size, 20);
  assert.equal(store.getMeta('M1').ownerNames.has('u24'), false);
  // one already held can still be changed when full
  store.setMeta('M1', { ownerNameFor: { userId: 'u3', name: `  ${'x'.repeat(500)}  ` } });
  assert.equal(store.getMeta('M1').ownerNames.get('u3').length, 200);
  // what is not a name or not an id changes nothing
  for (const bad of [null, 'u1', [], { userId: 'u1' }, { userId: 'u1', name: ' ' }, { userId: 'u1', name: 5 }, { userId: '', name: 'A' }, { userId: 5, name: 'A' }, { userId: 'x'.repeat(300), name: 'A' }]) {
    store.setMeta('M1', { ownerNameFor: bad });
  }
  assert.equal(store.getMeta('M1').ownerNames.get('u1'), 'Name 1');
  assert.equal(store.getMeta('M1').ownerNames.size, 20);
  // a copy is handed out, not the store's own map
  store.getMeta('M1').ownerNames.clear();
  assert.equal(store.getMeta('M1').ownerNames.size, 20);
  // other meta is untouched by it
  assert.equal(store.getMeta('M1').whoCanAsk, 'owner');
  // a meeting not held takes nothing
  assert.equal(store.setMeta('unknown', { ownerNameFor: { userId: 'u1', name: 'A' } }), null);

  store.deleteMeeting('M1');
  assert.deepEqual([...store.getMeta('M1').ownerNames], []);
});

// --- the route ---------------------------------------------------------------------

const internal = { 'x-arlo-internal-key': h.internalKey() };
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
let people = 0;
function person(displayName) {
  people += 1;
  const zoomUserId = `zoom-owner-name-${people}`;
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
async function put(meetingId, who, pass, body) {
  const res = await fetch(`${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/arlo/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: [pass, who?.session].filter(Boolean).join('; ') },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function openPanel(meetingId, pass, who) {
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, { cookie: [pass, who?.session].filter(Boolean).join('; ') });
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId } }));
  await h.wait(100);
  return ws;
}
const states = (ws) => ws.messages.filter((m) => m.type === 'arlo.state').map((m) => m.data);

test('the owner\'s panel supplies the name: every panel is told, once', async () => {
  const meeting = 'OWNER-NAME-1==';
  const ana = person(' '); // what sign-in stored when Zoom gave no names
  const pass = await access(meeting);
  const guest = await openPanel(meeting, pass, null);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  await h.wait(100);
  assert.equal(states(guest).at(-1).ownerName, null);
  assert.equal(states(guest).at(-1).present, true);

  const res = await put(meeting, ana, pass, { displayName: '  Ana from Zoom ' });
  await h.wait(100);
  assert.equal(res.status, 200);
  assert.equal(res.body.ownerName, 'Ana from Zoom');
  assert.equal(res.body.role, 'owner');
  assert.equal(states(guest).at(-1).ownerName, 'Ana from Zoom');
  const told = states(guest).length;
  // the same name again: nothing is sent again
  assert.equal((await put(meeting, ana, pass, { displayName: 'Ana from Zoom' })).status, 200);
  await h.wait(100);
  assert.equal(states(guest).length, told);

  // together with the other setting
  const both = await put(meeting, ana, pass, { whoCanAsk: 'anyone', displayName: 'Ana R.' });
  await h.wait(100);
  guest.socket.close();
  assert.equal(both.status, 200);
  assert.deepEqual([states(guest).at(-1).ownerName, states(guest).at(-1).whoCanAsk], ['Ana R.', 'anyone']);
});

test('only an owner may supply a name, and only a sane one', async () => {
  const meeting = 'OWNER-NAME-2==';
  const ana = person('');
  const ben = person('Ben Okafor'); // signed in, in the meeting, not an owner
  const pass = await access(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });

  assert.equal((await put(meeting, ben, pass, { displayName: 'Ben as owner' })).status, 403);
  assert.equal((await put(meeting, null, pass, { displayName: 'Nobody' })).status, 401);
  assert.equal((await put(meeting, ana, await access('OWNER-NAME-OTHER=='), { displayName: 'Ana' })).status, 403);

  const bad = [
    {}, { displayName: '' }, { displayName: '   ' }, { displayName: 'x'.repeat(101) }, { displayName: null },
    { displayName: 7 }, { displayName: ['Ana'] }, { displayName: { name: 'Ana' } }, { displayName: true },
    { displayName: 'Ana\nRuiz' }, { displayName: 'Ana\u0000' }, { displayName: 'A\u001bna' }, { displayName: 'Ana\u007f' }, { displayName: 'A\u0085na' },
    { displayName: 'Ana', extra: 1 }, { displayName: 'Ana', ownerUserId: ben.user.id }, { displayName: 'Ana', userId: ben.user.id },
    { displayName: 'Ana', whoCanAsk: 'everyone' }, { whoCanAsk: 'anyone', displayName: '' },
  ];
  for (const body of bad) {
    assert.equal((await put(meeting, ana, pass, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(getMeetingStore().getMeta(meeting).ownerNames.size, 0);
  assert.equal(getMeetingStore().getMeta(meeting).whoCanAsk, 'owner');

  // nothing that shows as a blank, hides, or turns the sentence around
  for (const [label, char] of Object.entries(INVISIBLE)) {
    for (const displayName of [char, char.repeat(4), `An${char}a`, `${char}Ana${char}Ruiz`]) {
      assert.equal((await put(meeting, ana, pass, { displayName })).status, 400, `${label}: ${JSON.stringify(displayName)}`);
    }
  }
  // a name has a letter or a digit in it
  for (const displayName of ['...', '🎉🎉', '-', '\u0301\u0301']) {
    assert.equal((await put(meeting, ana, pass, { displayName })).status, 400, JSON.stringify(displayName));
  }
  assert.equal(getMeetingStore().getMeta(meeting).ownerNames.size, 0);
  for (const displayName of ORDINARY_NAMES) {
    const res = await put(meeting, ana, pass, { displayName });
    assert.equal(res.status, 200, displayName);
    assert.equal(res.body.ownerName, displayName.normalize('NFC'));
  }
  // kept in one form (NFC), and counted in that form
  assert.equal((await put(meeting, ana, pass, { displayName: 'Jose\u0301' })).body.ownerName, 'José');
  assert.equal((await put(meeting, ana, pass, { displayName: 'e\u0301'.repeat(100) })).status, 200);

  // 100 characters after trimming is the most
  assert.equal((await put(meeting, ana, pass, { displayName: ` ${'x'.repeat(100)} ` })).status, 200);
  assert.equal(getMeetingStore().getMeta(meeting).ownerNames.get(ana.user.id).length, 100);
});

test('an account name wins over a supplied one, and the supplied one is not kept', async () => {
  const meeting = 'OWNER-NAME-3==';
  const ana = person('Ana Ruiz');
  const pass = await access(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  const res = await put(meeting, ana, pass, { displayName: 'Screen Name' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ownerName, 'Ana Ruiz');
  assert.equal(getMeetingStore().getMeta(meeting).ownerNames.size, 0);
});

test('a supplied name goes when the meeting\'s data is flushed', async () => {
  const meeting = 'OWNER-NAME-4==';
  const ana = person('');
  const pass = await access(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  await put(meeting, ana, pass, { displayName: 'Ana from Zoom' });
  assert.equal(getMeetingStore().getMeta(meeting).ownerNames.size, 1);

  await status(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  await h.wait(50);
  assert.equal(getMeetingStore().has(meeting), false);
  assert.equal(getMeetingStore().getMeta(meeting).ownerNames.size, 0);
  // and nothing can be supplied for a meeting that is gone
  assert.equal((await put(meeting, ana, pass, { displayName: 'Ana from Zoom' })).status, 403);
});
