// Browser sign-in (GET /api/auth/start -> Zoom -> GET /api/auth/callback).
// The flow uses PKCE with S256 and a state value, as Zoom's own Zoom Apps
// sample does. Zoom's token and profile endpoints are stubbed.
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const original = { post: axios.post, get: axios.get };
let tokenRequests;
function stubZoom() {
  tokenRequests = [];
  axios.post = async (url, body) => {
    tokenRequests.push({ url, params: Object.fromEntries(new URLSearchParams(body.toString())) });
    return { data: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'zoomapp:inmeeting' } };
  };
  axios.get = async () => ({ data: { id: `zoom-web-${crypto.randomUUID()}`, email: 'a@example.test', first_name: 'Ana', last_name: 'Ruiz', pic_url: null } });
}
test.afterEach(() => Object.assign(axios, original));

const start = async () => {
  const res = await fetch(`${srv.base}/api/auth/start`, { redirect: 'manual' });
  return new URL(res.headers.get('location'));
};
const callback = (query) => fetch(`${srv.base}/api/auth/callback?${new URLSearchParams(query)}`, { redirect: 'manual' });
const s256 = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

test('sign-in sends the browser to Zoom with a state and an S256 PKCE challenge', async () => {
  const url = await start();
  assert.equal(`${url.origin}${url.pathname}`, 'https://zoom.us/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://arlo.example.test/api/auth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(url.searchParams.get('state').length >= 16);
});

test('every sign-in gets its own state and challenge', async () => {
  const [a, b] = [await start(), await start()];
  assert.notEqual(a.searchParams.get('state'), b.searchParams.get('state'));
  assert.notEqual(a.searchParams.get('code_challenge'), b.searchParams.get('code_challenge'));
});

test('the callback exchanges the code with the matching verifier, signs the user in and opens the welcome page', async () => {
  stubZoom();
  const url = await start();
  const res = await callback({ code: 'auth-code-1', state: url.searchParams.get('state') });

  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/#\/welcome\?.*launch=1/);
  const cookies = res.headers.getSetCookie().map((c) => c.split('=')[0]);
  assert.ok(cookies.includes('sessionToken'));

  assert.equal(tokenRequests.length, 1);
  const { params } = tokenRequests[0];
  assert.equal(params.grant_type, 'authorization_code');
  assert.equal(params.code, 'auth-code-1');
  assert.equal(params.redirect_uri, 'https://arlo.example.test/api/auth/callback');
  // The verifier sent to Zoom is the one the challenge was made from
  assert.equal(s256(params.code_verifier), url.searchParams.get('code_challenge'));
});

test('a state can be used once', async () => {
  stubZoom();
  const url = await start();
  const state = url.searchParams.get('state');
  await callback({ code: 'auth-code-1', state });
  const replay = await callback({ code: 'auth-code-2', state });
  assert.match(replay.headers.get('location'), /auth-error\?error=invalid_state/);
  assert.equal(tokenRequests.length, 1);
});

test('an unknown state is refused before anything is sent to Zoom', async () => {
  stubZoom();
  const res = await callback({ code: 'auth-code-1', state: 'made-up-state' });
  assert.match(res.headers.get('location'), /auth-error\?error=invalid_state/);
  assert.equal(tokenRequests.length, 0);
});

test('an install started from the Marketplace (no state) still works, without a verifier', async () => {
  stubZoom();
  const res = await callback({ code: 'auth-code-mp' });
  assert.match(res.headers.get('location'), /\/#\/welcome/);
  assert.equal('code_verifier' in tokenRequests[0].params, false);
});

test('a denial from Zoom goes to the error page', async () => {
  const res = await callback({ error: 'access_denied' });
  assert.match(res.headers.get('location'), /auth-error\?error=access_denied/);
});
