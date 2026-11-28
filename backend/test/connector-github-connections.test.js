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
  const removed = [];
  const discarded = [];
  const store = createGithubConnections({
    onRemoved: (userId) => removed.push(userId),
    onDiscarded: (held, how) => discarded.push({ held, ...how }),
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
  const heldOf = (record) => ({
    accessToken: record.accessToken, expiresAt: record.expiresAt, refreshToken: record.refreshToken, refreshExpiresAt: record.refreshExpiresAt,
  });
  return {
    store, clock, sealed, refreshCalls, record, fresh, removed, discarded, heldOf,
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

// --- a token GitHub refused, removals nobody asked for, and handing the tokens over to be revoked ---

test('a token GitHub refused is refreshed at once, whatever its expiry says, and both new tokens are kept', async () => {
  const s = setup({ refresh: () => next });
  const first = s.record();
  const next = s.fresh();
  s.store.set('user-a', first);
  s.store.set('user-b', s.record());
  assert.equal(await s.store.refreshAccessToken('user-a', first.accessToken), next.tokens.accessToken);
  assert.deepEqual(s.refreshCalls, [first.refreshToken]);
  assert.equal(await s.store.getAccessToken('user-a'), next.tokens.accessToken);
  assert.deepEqual(s.store.status('user-a'), { connected: true, login: 'octo-cat' });
  // someone who is not connected has nothing to refresh
  assert.equal(await s.store.refreshAccessToken('user-c', first.accessToken), null);
  assert.equal(s.refreshCalls.length, 1);
  assert.deepEqual(s.removed, []);
});

test('a refused token that was replaced meanwhile: the new one is the answer and GitHub is not asked again', async () => {
  const s = setup({ refresh: () => s.fresh() });
  const first = s.record();
  s.store.set('user-a', first);
  const second = await s.store.refreshAccessToken('user-a', first.accessToken);
  assert.equal(s.refreshCalls.length, 1);
  // another call of the same user got its 401 with the old token a moment later
  assert.equal(await s.store.refreshAccessToken('user-a', first.accessToken), second);
  assert.equal(s.refreshCalls.length, 1);
});

test('many refused calls of one user at once are one refresh, and another user\'s token is never the answer', async () => {
  const waiting = [];
  const s = setup({ refresh: () => new Promise((resolve) => { waiting.push(resolve); }) });
  const [a, b] = [s.record(), s.record({ login: 'ben-gh' })];
  s.store.set('user-a', a);
  s.store.set('user-b', b);
  const asked = [
    s.store.refreshAccessToken('user-a', a.accessToken), s.store.refreshAccessToken('user-a', a.accessToken),
    s.store.refreshAccessToken('user-b', b.accessToken), s.store.refreshAccessToken('user-a', a.accessToken),
  ];
  await Promise.resolve();
  assert.equal(waiting.length, 2);
  const [forA, forB] = [s.fresh(), s.fresh()];
  assert.deepEqual(s.refreshCalls, [a.refreshToken, b.refreshToken]);
  waiting[1](forB);
  waiting[0](forA);
  const got = await Promise.all(asked);
  assert.deepEqual(got, [forA.tokens.accessToken, forA.tokens.accessToken, forB.tokens.accessToken, forA.tokens.accessToken]);
  assert.equal(await s.store.getAccessToken('user-b'), forB.tokens.accessToken);
});

test('a refused token and a refresh GitHub refuses: the connection is over and its user is told; one GitHub cannot be asked for is kept, and the refused token is not handed out', async () => {
  const refusing = setup({ refresh: () => ({ ok: false, code: 'bad_refresh_token', refused: true }) });
  const first = refusing.record();
  refusing.store.set('user-a', first);
  refusing.store.set('user-b', refusing.record());
  assert.equal(await refusing.store.refreshAccessToken('user-a', first.accessToken), null);
  assert.deepEqual(refusing.store.status('user-a'), { connected: false, login: null });
  assert.deepEqual(refusing.removed, ['user-a']);
  assert.equal(refusing.store.status('user-b').connected, true);

  const down = setup({ refresh: () => ({ ok: false, code: 'timeout', refused: false }) });
  const held = down.record();
  down.store.set('user-a', held);
  assert.equal(await down.store.refreshAccessToken('user-a', held.accessToken), null);
  assert.equal(down.store.status('user-a').connected, true);
  assert.deepEqual(down.removed, []);

  const expired = setup({ refresh: () => assert.fail('no refresh expected') });
  const old = expired.record();
  expired.store.set('user-a', old);
  expired.clock.at = old.refreshExpiresAt;
  assert.equal(await expired.store.refreshAccessToken('user-a', old.accessToken), null);
  assert.deepEqual(expired.removed, ['user-a']);
});

test('a removal its user did not ask for is told, once; one they asked for is not', async () => {
  const s = setup({ refresh: () => ({ ok: false, code: 'bad_refresh_token', refused: true }), maxUsers: 2 });
  // refused at the regular refresh
  const first = s.record();
  s.store.set('u1', first);
  s.clock.at = first.expiresAt;
  assert.equal(await s.store.getAccessToken('u1'), null);
  assert.deepEqual(s.removed, ['u1']);
  // dropped: GitHub keeps refusing the token
  s.store.set('u2', s.record());
  assert.equal(s.store.drop('u2'), true);
  assert.equal(s.store.drop('u2'), false);
  assert.deepEqual(s.removed, ['u1', 'u2']);
  // pushed out by a newer connection
  for (const id of ['u3', 'u4', 'u5']) s.store.set(id, s.record());
  assert.deepEqual(s.removed, ['u1', 'u2', 'u3']);
  // Disconnect, logout: their own doing
  assert.equal(s.store.remove('u4'), true);
  assert.notEqual(s.store.take('u5'), null);
  assert.deepEqual(s.removed, ['u1', 'u2', 'u3']);
  assert.equal(s.store.size(), 0);

  // a listener that fails does not undo a removal
  const failing = createGithubConnections({
    encrypt: encryptToken, decrypt: decryptToken, refresh: async () => ({}), onRemoved: () => { throw new Error('boom'); },
  });
  failing.set('u1', { ...s.record(), expiresAt: Date.now() + HOUR, refreshExpiresAt: Date.now() + 2 * HOUR });
  assert.equal(failing.drop('u1'), true);
  assert.equal(failing.status('u1').connected, false);
});

test('take: the connection is gone at once and its tokens are handed to the caller that revokes them, once, never the login', async () => {
  const s = setup({ refresh: () => assert.fail('no refresh expected') });
  const [a, b] = [s.record({ login: 'ana-gh' }), s.record({ login: 'ben-gh' })];
  s.store.set('user-a', a);
  s.store.set('user-b', b);
  assert.deepEqual(s.store.take('user-a'), {
    accessToken: a.accessToken, expiresAt: a.expiresAt, refreshToken: a.refreshToken, refreshExpiresAt: a.refreshExpiresAt,
  });
  assert.deepEqual(s.store.status('user-a'), { connected: false, login: null });
  assert.equal(await s.store.getAccessToken('user-a'), null);
  assert.equal(s.store.take('user-a'), null);
  assert.equal(s.store.take('user-c'), null);
  assert.equal(await s.store.getAccessToken('user-b'), b.accessToken);
});

test('a refused token that joins a refresh already running: when GitHub could not be asked, the refused token is not the answer', async () => {
  let answer;
  const s = setup({ refresh: () => new Promise((resolve) => { answer = resolve; }) });
  const first = s.record();
  s.store.set('user-a', first);
  // the regular refresh, a minute before the token runs out
  s.clock.at = first.expiresAt - 30 * 1000;
  const regular = s.store.getAccessToken('user-a');
  const refused = s.store.refreshAccessToken('user-a', first.accessToken);
  await Promise.resolve();
  answer({ ok: false, code: 'unreachable', refused: false });
  // whoever only asked for a token gets the old one while it lasts; whoever was refused with it does not
  assert.equal(await regular, first.accessToken);
  assert.equal(await refused, null);
  assert.equal(s.refreshCalls.length, 1);
  assert.equal(s.store.status('user-a').connected, true);
});

// --- tokens that work at GitHub and that the store no longer holds ---------------------

test('connecting another GitHub account: the old connection is handed over to be revoked as a whole; the same account: nothing', () => {
  const s = setup({ refresh: () => assert.fail('no refresh expected') });
  const [first, same, other] = [s.record({ githubUserId: 7 }), s.record({ githubUserId: 7 }), s.record({ githubUserId: 8, login: 'ana-work' })];
  s.store.set('user-a', first);
  s.store.set('user-a', same);
  assert.deepEqual(s.discarded, []);
  s.store.set('user-a', other);
  // Never the login or the GitHub user id: only what revoking needs
  assert.deepEqual(s.discarded, [{ held: s.heldOf(same), whole: true }]);
  assert.deepEqual(s.store.status('user-a'), { connected: true, login: 'ana-work' });
  // A record that is refused replaces nothing and revokes nothing
  assert.equal(s.store.set('user-a', { ...s.record({ githubUserId: 9 }), accessToken: 'no' }), false);
  assert.equal(s.discarded.length, 1);
  // Their own Disconnect is revoked by whoever took the connection, not from here
  s.store.take('user-a');
  assert.equal(s.discarded.length, 1);
});

test('a connection pushed out because the store is full is handed over to be revoked as a whole', () => {
  const s = setup({ refresh: () => ({}), maxUsers: 2 });
  const [a, b, c] = [s.record(), s.record({ githubUserId: 2 }), s.record({ githubUserId: 3 })];
  s.store.set('u1', a);
  s.store.set('u2', b);
  s.store.set('u3', c);
  assert.deepEqual(s.removed, ['u1']);
  assert.deepEqual(s.discarded, [{ held: s.heldOf(a), whole: true }]);
  assert.equal(s.store.status('u2').connected, true);
});

test('a listener that fails to revoke does not undo what the store did', () => {
  const failing = createGithubConnections({
    encrypt: encryptToken, decrypt: decryptToken, refresh: async () => ({}), onDiscarded: () => { throw new Error('boom'); }, maxUsers: 1,
  });
  const record = (githubUserId) => ({
    accessToken: made('ghu'), expiresAt: Date.now() + HOUR, refreshToken: made('ghr'), refreshExpiresAt: Date.now() + 2 * HOUR, login: 'octo-cat', githubUserId,
  });
  assert.equal(failing.set('u1', record(1)), true);
  assert.equal(failing.set('u1', record(2)), true);
  assert.equal(failing.set('u2', record(3)), true);
  assert.equal(failing.status('u1').connected, false);
  assert.equal(failing.status('u2').connected, true);
});

/** A store whose refresh is answered by hand: `answer(result)`. */
function midRefresh() {
  let answer;
  const s = setup({ refresh: () => new Promise((resolve) => { answer = resolve; }) });
  const first = s.record();
  s.store.set('user-a', first);
  s.clock.at = first.expiresAt - 30 * 1000;
  const asked = s.store.getAccessToken('user-a');
  return { ...s, first, asked, answer: (result) => answer(result) };
}

test('take while a refresh runs: the tokens GitHub may be ending, and a promise of the ones the refresh brings', async () => {
  const s = midRefresh();
  const held = s.store.take('user-a');
  assert.equal(held.accessToken, s.first.accessToken);
  assert.ok(held.refreshed instanceof Promise);
  assert.equal(s.store.status('user-a').connected, false);
  const fresh = s.fresh();
  s.answer(fresh);
  // To whoever took the connection, in the shape that is revoked with; and not revoked from here as well
  assert.deepEqual(await held.refreshed, fresh.tokens);
  assert.equal(await s.asked, null);
  assert.deepEqual(s.discarded, []);
  assert.equal(s.store.status('user-a').connected, false);
  assert.equal(s.store.size(), 0);
});

test('take while a refresh runs that brings nothing: the promise is of null, whatever went wrong', async () => {
  for (const result of [{ ok: false, code: 'unreachable', refused: false }, { ok: false, code: 'bad_refresh_token', refused: true }, null, { ok: true, tokens: { accessToken: 'no' } }]) {
    const s = midRefresh();
    const held = s.store.take('user-a');
    s.answer(result);
    assert.equal(await held.refreshed, null);
    assert.deepEqual(s.discarded, []);
  }
  // A refresh that throws
  const s = setup({ refresh: async () => { await Promise.resolve(); throw new Error('boom'); } });
  const first = s.record();
  s.store.set('user-a', first);
  s.clock.at = first.expiresAt - 30 * 1000;
  const asked = s.store.getAccessToken('user-a');
  const held = s.store.take('user-a');
  assert.equal(await held.refreshed, null);
  assert.equal(await asked, null);
});

test('take without a refresh running has no promise, and a refresh of the connection made since is not handed to it', async () => {
  const s = midRefresh();
  const fresh = s.fresh();
  s.answer(fresh);
  await s.asked;
  const held = s.store.take('user-a');
  assert.equal('refreshed' in held, false);
  assert.equal(held.accessToken, fresh.tokens.accessToken);
});

test('a refresh that lands after its connection was replaced or removed: the new token is handed over to be revoked, that token only', async () => {
  // Replaced by a new connection to the same account: the grant is the new connection's too
  const replaced = midRefresh();
  const again = replaced.record();
  replaced.store.set('user-a', again);
  assert.deepEqual(replaced.discarded, []);
  const fresh = replaced.fresh();
  replaced.answer(fresh);
  assert.equal(await replaced.asked, null);
  assert.deepEqual(replaced.discarded, [{ held: fresh.tokens, whole: false }]);
  // The new connection is as it was set
  replaced.clock.at = again.expiresAt - 2 * HOUR;
  assert.equal(await replaced.store.getAccessToken('user-a'), again.accessToken);

  // Removed
  const removed = midRefresh();
  removed.store.remove('user-a');
  const next = removed.fresh();
  removed.answer(next);
  await removed.asked;
  assert.deepEqual(removed.discarded, [{ held: next.tokens, whole: false }]);

  // The refresh brought nothing: nothing to revoke
  const nothing = midRefresh();
  nothing.store.remove('user-a');
  nothing.answer({ ok: false, code: 'unreachable', refused: false });
  await nothing.asked;
  assert.deepEqual(nothing.discarded, []);
});

test('a connection that is over while its refresh runs (another account, pushed out) is revoked as a whole with what the refresh brought', async () => {
  const s = midRefresh();
  s.store.set('user-a', s.record({ githubUserId: 99, login: 'ana-work' }));
  // Not with the tokens GitHub is ending right now
  assert.deepEqual(s.discarded, []);
  const fresh = s.fresh();
  s.answer(fresh);
  await s.asked;
  assert.deepEqual(s.discarded, [{ held: fresh.tokens, whole: true }]);

  // The refresh could not be asked: the tokens it had still work
  const failed = midRefresh();
  failed.store.set('user-a', failed.record({ githubUserId: 99 }));
  failed.answer({ ok: false, code: 'unreachable', refused: false });
  await failed.asked;
  assert.deepEqual(failed.discarded, [{ held: failed.heldOf(failed.first), whole: true }]);
});
