// A backend restart wipes the in-memory users and tokens. The session must
// survive it without a database: an encrypted, httpOnly restore cookie lets the
// server rebuild the user's record on the next request.
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateToken, decryptToken } = require('../src/services/auth');
const { sealSession, RESTORE_COOKIE } = require('../src/services/sessionRestore');
const { userStore, tokenStore, clearAll } = require('../src/lib/memoryStore');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

/** Sign a user in the way the OAuth callback does, and return their cookies. */
function signIn(zoomUserId = 'zoom-ana', displayName = 'Ana Ruiz') {
  const user = userStore.upsert(zoomUserId, { email: 'ana@example.test', displayName, avatarUrl: null });
  const session = generateToken({ userId: user.id, zoomUserId, exp: Date.now() + 60_000 });
  const restore = sealSession({ user, refreshToken: `refresh-for-${zoomUserId}`, scopes: ['user:read:user'] });
  return { user, session, restore };
}
const cookies = ({ session, restore }) => ({
  cookie: [`sessionToken=${session}`, restore && `${RESTORE_COOKIE}=${restore}`].filter(Boolean).join('; '),
});
const me = (headers) => fetch(`${srv.base}/api/auth/me`, { headers });
const restart = () => clearAll(); // what a backend restart does to memory

test('after a restart the same user is still signed in', async () => {
  const signedIn = signIn();
  restart();

  const res = await me(cookies(signedIn));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.id, signedIn.user.id);
  assert.equal(body.user.displayName, 'Ana Ruiz');
});

test('the Zoom refresh token comes back too, still encrypted in memory', async () => {
  const signedIn = signIn();
  restart();
  await me(cookies(signedIn));

  const stored = tokenStore.get(signedIn.user.id);
  assert.notEqual(stored.refreshToken, 'refresh-for-zoom-ana');
  assert.equal(decryptToken(stored.refreshToken), 'refresh-for-zoom-ana');
  assert.equal(new Date(stored.expiresAt) <= new Date(), true); // access token must be refreshed before use
});

test('without the restore cookie a restart still signs the user out', async () => {
  const signedIn = signIn();
  restart();
  const res = await me(cookies({ session: signedIn.session }));
  assert.notEqual(res.status, 200);
});

test('a restore cookie only restores the user the session token names', async () => {
  const ana = signIn('zoom-ana', 'Ana Ruiz');
  const ben = signIn('zoom-ben', 'Ben Okafor');
  restart();
  const res = await me(cookies({ session: ana.session, restore: ben.restore }));
  assert.notEqual(res.status, 200);
  assert.equal(userStore.findById(ben.user.id), null);
});

test('a tampered or garbage restore cookie is ignored without an error', async () => {
  const signedIn = signIn();
  restart();
  const flipped = signedIn.restore.slice(0, -2) + (signedIn.restore.endsWith('00') ? '11' : '00');
  for (const restore of [flipped, 'not-a-cookie', 'a:b:c', 'x'.repeat(5000)]) {
    const res = await me(cookies({ session: signedIn.session, restore }));
    assert.notEqual(res.status, 200);
    assert.notEqual(res.status, 500);
  }
});

test('the three token kinds cannot stand in for each other', async () => {
  const signedIn = signIn();
  restart();
  // restore blob presented as the session token
  assert.equal((await me({ cookie: `sessionToken=${signedIn.restore}` })).status, 401);
  // session token presented as the restore cookie
  const res = await me({ cookie: `sessionToken=${signedIn.session}; ${RESTORE_COOKIE}=${signedIn.session}` });
  assert.notEqual(res.status, 200);
});

test('logout clears the restore cookie as well as the session', async () => {
  const signedIn = signIn();
  const res = await fetch(`${srv.base}/api/auth/logout`, { method: 'POST', headers: cookies(signedIn) });
  assert.equal(res.status, 200);
  const cleared = res.headers.getSetCookie().map((c) => c.split('=')[0]);
  assert.equal(cleared.includes('sessionToken'), true);
  assert.equal(cleared.includes(RESTORE_COOKIE), true);
});
