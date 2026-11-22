// Zoom tells the app when a user removes it (app_deauthorized). Everything the
// server holds for that user must go, and their existing session must stop
// working, including the restore cookie that could otherwise rebuild it.
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateToken, encryptToken } = require('../src/services/auth');
const { sealSession, RESTORE_COOKIE } = require('../src/services/sessionRestore');
const { userStore, tokenStore } = require('../src/lib/memoryStore');
const deauthorized = require('../src/lib/deauthorized');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });
test.beforeEach(() => deauthorized._resetForTests());

function signIn(zoomUserId) {
  const user = userStore.upsert(zoomUserId, { email: `${zoomUserId}@example.test`, displayName: zoomUserId, avatarUrl: null });
  tokenStore.store(user.id, { accessToken: encryptToken('at'), refreshToken: encryptToken('rt'), expiresAt: new Date(Date.now() + 60_000), scopes: [] });
  const session = generateToken({ userId: user.id, zoomUserId, exp: Date.now() + 60_000 });
  const restore = sealSession({ user, refreshToken: 'rt', scopes: [] });
  return { user, cookie: `sessionToken=${session}; ${RESTORE_COOKIE}=${restore}` };
}
const me = (cookie) => fetch(`${srv.base}/api/auth/me`, { headers: { cookie } });
const deauthorize = (payload, options) => h.postWebhook(srv.base, { event: 'app_deauthorized', payload }, options);
const payloadFor = (zoomUserId, overrides = {}) => ({
  account_id: 'acct-1', user_id: zoomUserId, signature: 'uninstall-1',
  deauthorization_time: new Date().toISOString(), client_id: 'test-client-id', ...overrides,
});

test('removing the app deletes the user and their tokens and ends their session', async () => {
  const ana = signIn('zoom-ana-d');
  assert.equal((await me(ana.cookie)).status, 200);

  assert.equal((await deauthorize(payloadFor('zoom-ana-d'))).status, 200);

  assert.equal(userStore.findById(ana.user.id), null);
  assert.equal(tokenStore.get(ana.user.id), null);
  // the old session and the restore cookie are both refused
  assert.equal((await me(ana.cookie)).status, 401);
  assert.equal(userStore.findById(ana.user.id), null);
});

test('other users are not affected', async () => {
  const ana = signIn('zoom-ana-d2');
  const ben = signIn('zoom-ben-d2');
  await deauthorize(payloadFor('zoom-ana-d2'));
  assert.equal((await me(ben.cookie)).status, 200);
  assert.notEqual(tokenStore.get(ben.user.id), null);
});

test('a user who was not in memory (server restarted since) is still locked out', async () => {
  const { clearAll } = require('../src/lib/memoryStore');
  const ana = signIn('zoom-ana-d3');
  clearAll();
  await deauthorize(payloadFor('zoom-ana-d3'));
  assert.equal((await me(ana.cookie)).status, 401);
  assert.equal(userStore.findById(ana.user.id), null);
});

test('authorizing the app again lifts the lock', () => {
  deauthorized.mark('zoom-ana-d4');
  assert.equal(deauthorized.isDeauthorized('zoom-ana-d4'), true);
  deauthorized.clear('zoom-ana-d4');
  assert.equal(deauthorized.isDeauthorized('zoom-ana-d4'), false);
});

test('a deauthorization for another app, unsigned, or malformed changes nothing', async () => {
  const ana = signIn('zoom-ana-d5');
  assert.equal((await deauthorize(payloadFor('zoom-ana-d5', { client_id: 'someone-elses-app' }))).status, 200);
  assert.equal((await deauthorize(payloadFor('zoom-ana-d5'), { sign: false })).status, 401);
  assert.equal((await deauthorize({ client_id: 'test-client-id' })).status, 200);
  assert.equal((await deauthorize({ client_id: 'test-client-id', user_id: { $ne: null } })).status, 200);
  assert.equal((await me(ana.cookie)).status, 200);
});

test('their open WebSocket is closed', async () => {
  const ana = signIn('zoom-ana-d6');
  const access = await h.postJson(`${srv.base}/api/auth/meeting-access`, { appContext: h.makeAppContext(h.meetingPayload()) }, { cookie: ana.cookie });
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=m`, { cookie: `${ana.cookie}; ${access.cookie}` });
  assert.equal(ws.open, true);
  const closed = new Promise((resolve) => ws.socket.on('close', resolve));
  await deauthorize(payloadFor('zoom-ana-d6'));
  const code = await Promise.race([closed, h.wait(1500).then(() => 'still open')]);
  assert.notEqual(code, 'still open');
});
