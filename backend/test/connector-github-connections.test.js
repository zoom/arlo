// Each connected user's GitHub tokens: encrypted in memory, handed out for one
// user only, refreshed once at a time. (The plan calls this file
// connector-github-tokens.test.js.) A made-up refresh and a made-up clock.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptToken, decryptToken } = require('../src/services/auth');
const { createGithubConnections } = require('../src/services/connectors/githubConnections');

const made = (prefix) => `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
const HOUR = 60 * 60 * 1000;

function setup({ refresh, maxUsers } = {}) {
  const clock = { at: 1_800_000_000_000 };
  const sealed = [];
  const refreshCalls = [];
  const store = createGithubConnections({
    encrypt: (text) => { const blob = encryptToken(text); sealed.push(blob); return blob; },
    decrypt: decryptToken,
    refresh: async (refreshToken) => { refreshCalls.push(refreshToken); return refresh(refreshToken); },
    now: () => clock.at,
    ...(maxUsers ? { maxUsers } : {}),
  });
  const record = (overrides = {}) => ({
    accessToken: made('ghu'),
    expiresAt: clock.at + 8 * HOUR,
    refreshToken: made('ghr'),
    refreshExpiresAt: clock.at + 4000 * HOUR,
    login: 'octo-cat',
    githubUserId: 583231,
    ...overrides,
  });
  const fresh = () => ({
    ok: true,
    tokens: {
      accessToken: made('ghu'), expiresAt: clock.at + 8 * HOUR, refreshToken: made('ghr'), refreshExpiresAt: clock.at + 4000 * HOUR,
    },
  });
  return {
    store, clock, sealed, refreshCalls, record, fresh,
  };
}

test('a connection is kept as one encrypted blob and handed out to its user only', async () => {
  const { store, sealed, record } = setup({ refresh: () => assert.fail('no refresh expected') });
  const [a, b] = [record({ login: 'ana-gh' }), record({ login: 'ben-gh', githubUserId: 7 })];
  assert.equal(store.set('user-a', a), true);
  assert.equal(store.set('user-b', b), true);

  assert.equal(await store.getAccessToken('user-a'), a.accessToken);
  assert.equal(await store.getAccessToken('user-b'), b.accessToken);
  assert.equal(await store.getAccessToken('user-c'), null);
  assert.deepEqual(store.status('user-a'), { connected: true, login: 'ana-gh' });
  assert.deepEqual(store.status('user-c'), { connected: false, login: null });

  // One blob per user, AES-GCM (iv:tag:ciphertext), and nothing readable in it
  assert.equal(sealed.length, 2);
  for (const blob of sealed) {
    assert.match(blob, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    for (const secret of [a.accessToken, a.refreshToken, b.accessToken, b.refreshToken, 'ana-gh', 'ben-gh']) {
      assert.equal(blob.includes(secret), false);
    }
  }
});

test('status never holds a token', () => {
  const { store, record } = setup({ refresh: () => ({}) });
  const a = record();
  store.set('user-a', a);
  const said = JSON.stringify(store.status('user-a'));
  assert.equal(said.includes(a.accessToken), false);
  assert.equal(said.includes(a.refreshToken), false);
  assert.deepEqual(Object.keys(store.status('user-a')).sort(), ['connected', 'login']);
});

test('a record with a field that is not what it must be is not kept', () => {
  const { store, record } = setup({ refresh: () => ({}) });
  const bad = [
    { accessToken: 'short' },
    { accessToken: `${made('ghu')}\r\nX-Evil: 1` },
    { accessToken: `Bearer ${made('ghu')}` },
    { refreshToken: undefined },
    { refreshToken: 'has spaces and is long enough' },
    { expiresAt: '2030-01-01' },
    { expiresAt: -1 },
    { refreshExpiresAt: NaN },
    { login: '<script>' },
    { login: '' },
    { githubUserId: '1' },
    { githubUserId: 0 },
  ];
  for (const overrides of bad) {
    assert.equal(store.set('user-a', record(overrides)), false, JSON.stringify(Object.keys(overrides)));
  }
  assert.equal(store.set('', record()), false);
  assert.equal(store.set(undefined, record()), false);
  assert.equal(store.set('user-a', null), false);
  assert.equal(store.size(), 0);
});

test('removing a connection forgets it', async () => {
  const { store, record } = setup({ refresh: () => assert.fail('no refresh expected') });
  store.set('user-a', record());
  store.set('user-b', record());
  assert.equal(store.remove('user-a'), true);
  assert.equal(store.remove('user-a'), false);
  assert.equal(await store.getAccessToken('user-a'), null);
  assert.deepEqual(store.status('user-a'), { connected: false, login: null });
  assert.equal(store.status('user-b').connected, true);
});

test('at most so many users: the one connected longest ago is dropped', () => {
  const { store, record } = setup({ refresh: () => ({}), maxUsers: 3 });
  for (const id of ['u1', 'u2', 'u3']) store.set(id, record());
  store.set('u1', record()); // connected again: now the newest
  store.set('u4', record());
  assert.equal(store.size(), 3);
  assert.equal(store.status('u2').connected, false);
  for (const id of ['u1', 'u3', 'u4']) assert.equal(store.status(id).connected, true);
  assert.equal(require('../src/services/connectors/githubConnections').MAX_USERS, 1000);
});

test('a token that runs out within a minute is refreshed first, and both new tokens are kept', async () => {
  const s = setup({ refresh: () => next });
  const first = s.record();
  let next = s.fresh();
  s.store.set('user-a', first);

  s.clock.at = first.expiresAt - 60 * 1000 - 1;
  assert.equal(await s.store.getAccessToken('user-a'), first.accessToken);
  assert.equal(s.refreshCalls.length, 0);

  s.clock.at = first.expiresAt - 60 * 1000;
  assert.equal(await s.store.getAccessToken('user-a'), next.tokens.accessToken);
  assert.deepEqual(s.refreshCalls, [first.refreshToken]);
  // the login stays, and the next refresh uses the new refresh token
  assert.deepEqual(s.store.status('user-a'), { connected: true, login: 'octo-cat' });
  const used = next.tokens;
  s.clock.at = used.expiresAt;
  next = s.fresh();
  assert.equal(await s.store.getAccessToken('user-a'), next.tokens.accessToken);
  assert.deepEqual(s.refreshCalls, [first.refreshToken, used.refreshToken]);
});

test('a refresh runs once per user however many ask at the same time', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const s = setup({ refresh: async () => { await gate; return answer; } });
  const answer = s.fresh();
  const a = s.record({ expiresAt: s.clock.at + 1000 });
  const b = s.record(); // not due
  s.store.set('user-a', a);
  s.store.set('user-b', b);

  const asked = [s.store.getAccessToken('user-a'), s.store.getAccessToken('user-a'), s.store.getAccessToken('user-a')];
  // Another user is not held up, and never gets A's token
  assert.equal(await s.store.getAccessToken('user-b'), b.accessToken);
  release();
  assert.deepEqual(await Promise.all(asked), [answer.tokens.accessToken, answer.tokens.accessToken, answer.tokens.accessToken]);
  assert.deepEqual(s.refreshCalls, [a.refreshToken]);
  assert.equal(await s.store.getAccessToken('user-b'), b.accessToken);
});

test('a refresh that GitHub refuses ends the connection', async () => {
  const s = setup({ refresh: () => ({ ok: false, code: 'bad_refresh_token', refused: true }) });
  s.store.set('user-a', s.record({ expiresAt: s.clock.at + 1000 }));
  assert.equal(await s.store.getAccessToken('user-a'), null);
  assert.deepEqual(s.store.status('user-a'), { connected: false, login: null });
  // and GitHub is not asked again
  assert.equal(await s.store.getAccessToken('user-a'), null);
  assert.equal(s.refreshCalls.length, 1);
});

test('a refresh that could not be asked keeps the connection; the old token is used while it lasts', async () => {
  const s = setup({ refresh: () => ({ ok: false, code: 'timeout', refused: false }) });
  const a = s.record({ expiresAt: s.clock.at + 30 * 1000 });
  s.store.set('user-a', a);
  assert.equal(await s.store.getAccessToken('user-a'), a.accessToken);
  s.clock.at = a.expiresAt;
  assert.equal(await s.store.getAccessToken('user-a'), null);
  assert.equal(s.store.status('user-a').connected, true);

  const thrown = setup({ refresh: () => { throw new Error('boom'); } });
  thrown.store.set('user-a', thrown.record({ expiresAt: thrown.clock.at - 1 }));
  assert.equal(await thrown.store.getAccessToken('user-a'), null);
  assert.equal(thrown.store.status('user-a').connected, true);
});

test('a refresh token that ran out ends the connection without asking GitHub', async () => {
  const s = setup({ refresh: () => assert.fail('no refresh expected') });
  s.store.set('user-a', s.record({ expiresAt: s.clock.at + 1000, refreshExpiresAt: s.clock.at + 2000 }));
  s.clock.at += 2000;
  assert.equal(await s.store.getAccessToken('user-a'), null);
  assert.equal(s.store.status('user-a').connected, false);
});

test('what a refresh answers is checked like any record', async () => {
  const s = setup({ refresh: () => ({ ok: true, tokens: { accessToken: 'x', expiresAt: 1, refreshToken: 'y', refreshExpiresAt: 2 } }) });
  s.store.set('user-a', s.record({ expiresAt: s.clock.at + 1000 }));
  assert.equal(await s.store.getAccessToken('user-a'), null);
  assert.equal(s.store.status('user-a').connected, false);
});

test('a user who disconnected while GitHub was asked stays disconnected', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const s = setup({ refresh: async () => { await gate; return answer; } });
  const answer = s.fresh();
  s.store.set('user-a', s.record({ expiresAt: s.clock.at + 1000 }));
  const asked = s.store.getAccessToken('user-a');
  s.store.remove('user-a');
  release();
  assert.equal(await asked, null);
  assert.equal(s.store.status('user-a').connected, false);
  assert.equal(s.store.size(), 0);
});

test('a blob that cannot be read (another key, changed bytes) is no connection', async () => {
  const s = setup({ refresh: () => ({}) });
  const store = createGithubConnections({
    encrypt: (text) => encryptToken(text).replace(/.$/, (c) => (c === '0' ? '1' : '0')),
    decrypt: decryptToken,
    refresh: () => ({}),
    now: () => s.clock.at,
  });
  assert.equal(store.set('user-a', s.record()), true);
  assert.deepEqual(store.status('user-a'), { connected: false, login: null });
  assert.equal(await store.getAccessToken('user-a'), null);
  assert.equal(store.size(), 0);
});
