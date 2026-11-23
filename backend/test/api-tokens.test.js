// Short-lived API tokens: a credential for scripts, so nobody has to copy a
// browser session cookie into a terminal. Stored only as a hash, in memory.
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateToken } = require('../src/services/auth');
const { userStore } = require('../src/lib/memoryStore');
const apiTokens = require('../src/lib/apiTokens');
const deauthorized = require('../src/lib/deauthorized');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });
test.beforeEach(() => { apiTokens._resetForTests(); deauthorized._resetForTests(); });

let n = 0;
function signIn() {
  n += 1;
  const user = userStore.upsert(`zoom-token-user-${n}`, { email: 'x@example.test', displayName: 'X', avatarUrl: null });
  const cookie = `sessionToken=${generateToken({ userId: user.id, zoomUserId: user.zoomUserId, exp: Date.now() + 60_000 })}`;
  return { user, cookie };
}
const api = (method, path, { cookie, bearer, body } = {}) => fetch(`${srv.base}${path}`, {
  method,
  headers: {
    ...(body !== undefined && { 'content-type': 'application/json' }),
    ...(cookie && { cookie }),
    ...(bearer && { authorization: `Bearer ${bearer}` }),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const create = async (cookie, body = { scopes: ['rtms:read'] }) => {
  const res = await api('POST', '/api/tokens', { cookie, body });
  return { res, data: await res.json() };
};
// A token-protected route to try tokens against
const useToken = (bearer, extra = {}) => api('GET', '/api/rtms/events', { bearer, ...extra });

test('a signed-in user creates a token and sees it exactly once', async () => {
  const { cookie } = signIn();
  const { res, data } = await create(cookie, { name: 'laptop script', scopes: ['rtms:control', 'rtms:read'], ttlMinutes: 30 });

  assert.equal(res.status, 201);
  assert.match(data.token, /^arlo_[A-Za-z0-9_-]{43}$/);
  assert.equal(data.name, 'laptop script');
  assert.deepEqual(data.scopes, ['rtms:control', 'rtms:read']);
  const lifetimeMin = (new Date(data.expiresAt) - Date.now()) / 60000;
  assert.ok(lifetimeMin > 29 && lifetimeMin <= 30);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  // listing never shows the token again
  const list = await (await api('GET', '/api/tokens', { cookie })).json();
  assert.equal(list.tokens.length, 1);
  assert.equal(list.tokens[0].id, data.id);
  assert.equal(JSON.stringify(list).includes(data.token), false);
  assert.equal('token' in list.tokens[0], false);
});

test('the server keeps only a hash of the token', async () => {
  const { cookie } = signIn();
  const { data } = await create(cookie);
  const dump = JSON.stringify(apiTokens._dumpForTests());
  assert.equal(dump.includes(data.token), false);
  assert.equal(dump.includes(data.token.slice(5)), false);
  assert.equal(dump.includes(crypto.createHash('sha256').update(data.token).digest('hex')), true);
});

test('a token works as a bearer credential until it is revoked', async () => {
  const { cookie } = signIn();
  const { data } = await create(cookie);
  assert.equal((await useToken(data.token)).status, 200);

  assert.equal((await api('DELETE', `/api/tokens/${data.id}`, { cookie })).status, 200);
  assert.equal((await useToken(data.token)).status, 401);
  assert.equal((await (await api('GET', '/api/tokens', { cookie })).json()).tokens.length, 0);
});

test('a token expires', async () => {
  const { cookie } = signIn();
  const { data } = await create(cookie);
  apiTokens._expireForTests(data.id);
  assert.equal((await useToken(data.token)).status, 401);
});

test('the default lifetime is one hour and the longest is 24 hours', async () => {
  const { cookie } = signIn();
  const minutes = (d) => Math.round((new Date(d.expiresAt) - Date.now()) / 60000);
  assert.equal(minutes((await create(cookie)).data), 60);
  assert.equal(minutes((await create(cookie, { scopes: ['rtms:read'], ttlMinutes: 24 * 60 })).data), 24 * 60);
  for (const ttlMinutes of [0, -5, 24 * 60 + 1, 'soon', 1.5]) {
    assert.equal((await create(cookie, { scopes: ['rtms:read'], ttlMinutes })).res.status, 400, `ttl ${ttlMinutes}`);
  }
});

test('a token only does what its scopes allow', async () => {
  const { cookie } = signIn();
  const readOnly = (await create(cookie, { scopes: ['rtms:read'] })).data.token;
  assert.equal((await useToken(readOnly)).status, 200);
  const res = await api('POST', '/api/rtms/start', { bearer: readOnly, body: { meetingId: '12345678901', action: 'start' } });
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /rtms:control/);
});

test('scopes must be known, and at least one is required', async () => {
  const { cookie } = signIn();
  for (const scopes of [[], ['everything'], ['rtms:read', 'admin'], 'rtms:read', undefined, [{ $ne: null }]]) {
    assert.equal((await create(cookie, { scopes })).res.status, 400, JSON.stringify(scopes));
  }
});

test('creating, listing and revoking tokens needs the browser session; a token cannot mint tokens', async () => {
  const { cookie } = signIn();
  const { data } = await create(cookie);
  assert.equal((await api('POST', '/api/tokens', { bearer: data.token, body: { scopes: ['rtms:read'] } })).status, 401);
  assert.equal((await api('GET', '/api/tokens', { bearer: data.token })).status, 401);
  assert.equal((await api('DELETE', `/api/tokens/${data.id}`, { bearer: data.token })).status, 401);
  assert.equal((await api('POST', '/api/tokens', { body: { scopes: ['rtms:read'] } })).status, 401);
});

test('a user has at most five live tokens', async () => {
  const { cookie } = signIn();
  for (let i = 0; i < 5; i += 1) assert.equal((await create(cookie)).res.status, 201);
  const sixth = await create(cookie);
  assert.equal(sixth.res.status, 429);
  assert.match(sixth.data.message, /revoke/i);
});

test('one user cannot see or revoke another user\'s tokens', async () => {
  const ana = signIn();
  const ben = signIn();
  const { data } = await create(ana.cookie);
  assert.equal((await (await api('GET', '/api/tokens', { cookie: ben.cookie })).json()).tokens.length, 0);
  assert.equal((await api('DELETE', `/api/tokens/${data.id}`, { cookie: ben.cookie })).status, 404);
  assert.equal((await useToken(data.token)).status, 200);
});

test('the other credentials are not API tokens, and an API token is not a session', async () => {
  const { cookie, user } = signIn();
  const { data } = await create(cookie);
  const sessionJwt = cookie.split('=')[1];

  assert.equal((await useToken(sessionJwt)).status, 401);                       // session token as bearer
  assert.equal((await useToken('arlo_' + 'A'.repeat(43))).status, 401);        // right shape, never issued
  assert.equal((await useToken('')).status, 401);
  assert.equal((await api('GET', '/api/auth/me', { cookie: `sessionToken=${data.token}` })).status, 401); // token as session cookie
  assert.equal((await api('GET', '/api/auth/me', { bearer: data.token })).status, 401);                    // token on a session-only route
  assert.ok(user);
});

test('a bad bearer token is refused even when a valid session cookie is also sent', async () => {
  const { cookie } = signIn();
  assert.equal((await useToken('arlo_' + 'B'.repeat(43), { cookie })).status, 401);
});

test('tokens die with the account: logout and app removal revoke them', async () => {
  const ana = signIn();
  const anaToken = (await create(ana.cookie)).data.token;
  await api('POST', '/api/auth/logout', { cookie: ana.cookie });
  assert.equal((await useToken(anaToken)).status, 401);

  const ben = signIn();
  const benToken = (await create(ben.cookie)).data.token;
  await h.postWebhook(srv.base, { event: 'app_deauthorized', payload: { user_id: ben.user.zoomUserId, client_id: 'test-client-id' } });
  assert.equal((await useToken(benToken)).status, 401);
});

test('the list shows when a token was last used', async () => {
  const { cookie } = signIn();
  const { data } = await create(cookie);
  const before = (await (await api('GET', '/api/tokens', { cookie })).json()).tokens[0];
  assert.equal(before.lastUsedAt, null);
  await useToken(data.token);
  const after = (await (await api('GET', '/api/tokens', { cookie })).json()).tokens[0];
  assert.ok(new Date(after.lastUsedAt) <= new Date());
});

test('a token never appears in the logs', async () => {
  const { cookie } = signIn();
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => lines.push(args.map(String).join(' '));
  let token;
  try {
    token = (await create(cookie)).data.token;
    await useToken(token);
    await useToken(`${token}x`);
  } finally { Object.assign(console, original); }
  assert.equal(lines.join('\n').includes(token.slice(5, 25)), false);
});
