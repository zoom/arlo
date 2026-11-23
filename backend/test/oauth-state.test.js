// OAuth state that survives a server restart. A sign-in spans two requests,
// sometimes a minute apart; state kept in memory was lost by any restart in
// between and the user got "Invalid OAuth state". The state is now signed and
// self-validating, and the PKCE verifier is derived from it.
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');
const oauthState = require('../src/services/oauthState');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const original = { post: axios.post, get: axios.get };
let tokenRequests;
function stubZoom() {
  tokenRequests = [];
  axios.post = async (url, body) => {
    tokenRequests.push(Object.fromEntries(new URLSearchParams(body.toString())));
    return { data: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'zoomapp:inmeeting' } };
  };
  axios.get = async () => ({ data: { id: `zoom-state-${crypto.randomUUID()}`, email: 'a@example.test', first_name: 'Ana', last_name: 'Ruiz', pic_url: null } });
}
test.afterEach(() => Object.assign(axios, original));

// What a restart does to this module: everything held in memory is gone
const restart = () => oauthState._resetForTests();

test('a state verifies, names its flow, and yields the same verifier every time', () => {
  for (const kind of ['web', 'inclient']) {
    const issued = oauthState.issue(kind);
    assert.match(issued.state, /^[A-Za-z0-9._-]{30,80}$/); // short: it travels in URLs and through the Zoom SDK
    assert.match(issued.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    const verified = oauthState.verify(issued.state);
    assert.equal(verified.kind, kind);
    assert.equal(verified.codeVerifier, issued.codeVerifier);
  }
});

test('states and verifiers are different for every sign-in', () => {
  const a = oauthState.issue('web');
  const b = oauthState.issue('web');
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.codeVerifier, b.codeVerifier);
});

test('a forged, altered, expired or malformed state is refused', () => {
  const { state } = oauthState.issue('web');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  assert.equal(oauthState.verify(flip(state, 3)), null);                 // nonce altered
  assert.equal(oauthState.verify(flip(state, state.length - 2)), null);  // signature altered
  assert.equal(oauthState.verify(state.replace(/^w/, 'i')), null);       // flow swapped
  assert.equal(oauthState.verify('made-up-state'), null);
  assert.equal(oauthState.verify(''), null);
  assert.equal(oauthState.verify(undefined), null);
  assert.equal(oauthState.verify({ $ne: 1 }), null);
  assert.equal(oauthState.verify('x'.repeat(5000)), null);

  const expired = oauthState.issue('web', { now: Date.now() - 6 * 60 * 1000 });
  assert.equal(oauthState.verify(expired.state), null);
});

test('a state is used once', () => {
  const { state } = oauthState.issue('web');
  assert.ok(oauthState.consume(state));
  assert.equal(oauthState.consume(state), null);
});

test('a browser sign-in survives a server restart between the two requests', async () => {
  stubZoom();
  const start = await fetch(`${srv.base}/api/auth/start`, { redirect: 'manual' });
  const url = new URL(start.headers.get('location'));
  restart();

  const res = await fetch(`${srv.base}/api/auth/callback?${new URLSearchParams({ code: 'c1', state: url.searchParams.get('state') })}`, { redirect: 'manual' });
  assert.match(res.headers.get('location'), /\/#\/welcome/);
  const challenge = crypto.createHash('sha256').update(tokenRequests[0].code_verifier).digest('base64url');
  assert.equal(challenge, url.searchParams.get('code_challenge'));
});

test('an in-client sign-in survives a server restart between the two requests', async () => {
  stubZoom();
  const { codeChallenge, state } = await (await fetch(`${srv.base}/api/auth/authorize`)).json();
  restart();

  const res = await h.postJson(`${srv.base}/api/auth/callback`, { code: 'c2', state });
  assert.equal(res.status, 200);
  assert.ok(res.body.user);
  // in-client PKCE uses the "plain" method: the verifier is the challenge
  assert.equal(tokenRequests[0].code_verifier, codeChallenge);
});

test('the browser leg of an in-client sign-in is recognised after a restart, not treated as a forged web sign-in', async () => {
  const { state } = await (await fetch(`${srv.base}/api/auth/authorize`)).json();
  restart();

  const res = await fetch(`${srv.base}/api/auth/callback?${new URLSearchParams({ code: 'c3', state })}`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Authorization Complete/);

  // and the panel can pick the code up
  const poll = await (await fetch(`${srv.base}/api/auth/poll-code?state=${encodeURIComponent(state)}`)).json();
  assert.deepEqual(poll, { ready: true, code: 'c3' });
});

test('an in-client state cannot be exchanged twice', async () => {
  stubZoom();
  const { state } = await (await fetch(`${srv.base}/api/auth/authorize`)).json();
  assert.equal((await h.postJson(`${srv.base}/api/auth/callback`, { code: 'c4', state })).status, 200);
  assert.equal((await h.postJson(`${srv.base}/api/auth/callback`, { code: 'c5', state })).status, 400);
  assert.equal(tokenRequests.length, 1);
});
