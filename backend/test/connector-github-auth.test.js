// "Connect GitHub", the flow itself: tickets, states, the calls to GitHub.
// A made-up fetch and a made-up clock: nothing here touches the network.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGithubAuth } = require('../src/services/connectors/githubAuth');
const { readGithubAppClientId, readGithubAppClientSecret } = require('../src/services/connectors/githubConfig');

// Made up for this run
const CLIENT_ID = 'Iv1.arlotestclient01';
const CLIENT_SECRET = crypto.randomBytes(20).toString('hex');
const PUBLIC_URL = 'https://arlo.example.test';
const made = (prefix) => `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
const COOKIE = () => crypto.randomBytes(32).toString('base64url');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup({ answer } = {}) {
  const clock = { at: 1_800_000_000_000 };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return answer(String(url), init);
  };
  const auth = createGithubAuth({
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, publicUrl: PUBLIC_URL, fetch, now: () => clock.at,
  });
  return { auth, clock, calls };
}

const tokenAnswer = (overrides = {}) => ({
  access_token: made('ghu'), expires_in: 28800, refresh_token: made('ghr'),
  refresh_token_expires_in: 15897600, scope: '', token_type: 'bearer', ...overrides,
});

test('the app settings: a client ID and secret of the expected shape, anything else ignored', () => {
  assert.deepEqual(readGithubAppClientId(undefined), { clientId: null, known: true });
  assert.deepEqual(readGithubAppClientId(CLIENT_ID), { clientId: CLIENT_ID, known: true });
  for (const bad of ['short', 'has space in it 123', `${'a'.repeat(61)}`, 'Iv1.abc\r\nX-Evil: 1', 42]) {
    assert.deepEqual(readGithubAppClientId(bad), { clientId: null, known: false });
  }
  assert.deepEqual(readGithubAppClientSecret(''), { clientSecret: null, known: true });
  assert.deepEqual(readGithubAppClientSecret(CLIENT_SECRET), { clientSecret: CLIENT_SECRET, known: true });
  for (const bad of ['tooshort', `${'a'.repeat(101)}`, `${'a'.repeat(30)}-dash`, `${'a'.repeat(30)}\n`, {}]) {
    assert.deepEqual(readGithubAppClientSecret(bad), { clientSecret: null, known: false });
  }
});

test('without a client ID or secret the flow is not available and asks GitHub nothing', async () => {
  const calls = [];
  const auth = createGithubAuth({ clientId: null, clientSecret: null, publicUrl: PUBLIC_URL, fetch: async () => { calls.push(1); } });
  assert.equal(auth.available, false);
  assert.equal(auth.createState({ userId: 'u1', cookieValue: COOKIE() }), null);
  assert.deepEqual(await auth.exchangeCode({ code: 'c'.repeat(20), codeVerifier: COOKIE() }), { ok: false, code: 'not_available' });
  assert.equal(calls.length, 0);
});

test('a ticket is 32 random bytes, names its user, and works once', () => {
  const { auth } = setup();
  const ticket = auth.issueTicket('user-a');
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(auth.issueTicket('user-a'), ticket);
  // Looking does not use it up
  assert.deepEqual(auth.peekTicket(ticket), { userId: 'user-a' });
  assert.deepEqual(auth.peekTicket(ticket), { userId: 'user-a' });
  assert.deepEqual(auth.consumeTicket(ticket), { userId: 'user-a' });
  assert.equal(auth.consumeTicket(ticket), null);
  assert.equal(auth.peekTicket(ticket), null);
});

test('a ticket that is unknown, of another shape or not a string names nobody', () => {
  const { auth } = setup();
  auth.issueTicket('user-a');
  for (const bad of [COOKIE(), 'short', `${'a'.repeat(44)}`, `${'a'.repeat(42)}!`, undefined, null, 42, ['x'], {}]) {
    assert.equal(auth.peekTicket(bad), null);
    assert.equal(auth.consumeTicket(bad), null);
  }
  assert.equal(auth.issueTicket(''), null);
  assert.equal(auth.issueTicket(undefined), null);
});

test('a ticket runs out after five minutes', () => {
  const { auth, clock } = setup();
  const ticket = auth.issueTicket('user-a');
  clock.at += 5 * 60 * 1000 - 1;
  assert.deepEqual(auth.peekTicket(ticket), { userId: 'user-a' });
  clock.at += 1;
  assert.equal(auth.peekTicket(ticket), null);
  assert.equal(auth.consumeTicket(ticket), null);
});

test('a user holds at most three open tickets: a fourth replaces their oldest, and nobody else\'s', () => {
  const { auth } = setup();
  const other = auth.issueTicket('user-b');
  const [first, second, third] = [auth.issueTicket('user-a'), auth.issueTicket('user-a'), auth.issueTicket('user-a')];
  const fourth = auth.issueTicket('user-a');
  assert.equal(auth.peekTicket(first), null);
  for (const ticket of [second, third, fourth]) assert.deepEqual(auth.peekTicket(ticket), { userId: 'user-a' });
  assert.deepEqual(auth.peekTicket(other), { userId: 'user-b' });
});

test('the authorize URL is GitHub\'s, built by the server, with state and PKCE S256', () => {
  const { auth } = setup();
  const cookieValue = COOKIE();
  const { state, url } = auth.createState({ userId: 'user-a', cookieValue });
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, 'https://github.com/login/oauth/authorize');
  assert.deepEqual([...parsed.searchParams.keys()].sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'prompt', 'redirect_uri', 'scope', 'state']);
  // GitHub's account picker, every time: the person sees and picks which account is connected
  assert.equal(parsed.searchParams.get('prompt'), 'select_account');
  assert.equal(parsed.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(parsed.searchParams.get('redirect_uri'), `${PUBLIC_URL}/api/connectors/github/callback`);
  assert.equal(parsed.searchParams.get('state'), state);
  assert.equal(parsed.searchParams.get('scope'), 'offline_access');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.match(parsed.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  // The challenge is the hash of the verifier the state holds, and neither the
  // verifier, the cookie nor the client secret is in the URL
  const flow = auth.consumeState(state, cookieValue);
  assert.equal(crypto.createHash('sha256').update(flow.codeVerifier).digest('base64url'), parsed.searchParams.get('code_challenge'));
  for (const secret of [flow.codeVerifier, cookieValue, CLIENT_SECRET]) assert.equal(url.includes(secret), false);
});

test('a state works once, for the browser it was made in, for ten minutes', () => {
  const { auth, clock } = setup();
  const cookieValue = COOKIE();

  const once = auth.createState({ userId: 'user-a', cookieValue }).state;
  assert.equal(auth.consumeState(once, cookieValue).userId, 'user-a');
  assert.equal(auth.consumeState(once, cookieValue), null); // reuse

  const wrongCookie = auth.createState({ userId: 'user-a', cookieValue }).state;
  assert.equal(auth.consumeState(wrongCookie, COOKIE()), null);
  // and it is used up by the attempt
  assert.equal(auth.consumeState(wrongCookie, cookieValue), null);

  const noCookie = auth.createState({ userId: 'user-a', cookieValue }).state;
  assert.equal(auth.consumeState(noCookie, undefined), null);

  const late = auth.createState({ userId: 'user-a', cookieValue }).state;
  clock.at += 10 * 60 * 1000;
  assert.equal(auth.consumeState(late, cookieValue), null);

  assert.equal(auth.consumeState(COOKIE(), cookieValue), null); // unknown
  assert.equal(auth.consumeState(['x'], cookieValue), null);
  assert.equal(auth.createState({ userId: 'user-a', cookieValue: 'not-a-cookie' }), null);
});

test('a state names the user it was made for and nobody else', () => {
  const { auth } = setup();
  const [cookieA, cookieB] = [COOKIE(), COOKIE()];
  const stateA = auth.createState({ userId: 'user-a', cookieValue: cookieA }).state;
  const stateB = auth.createState({ userId: 'user-b', cookieValue: cookieB }).state;
  assert.equal(auth.consumeState(stateB, cookieB).userId, 'user-b');
  assert.equal(auth.consumeState(stateA, cookieA).userId, 'user-a');
});

test('forgetting a user drops their open tickets and states and cancels a callback that is running', () => {
  const { auth } = setup();
  const cookieValue = COOKIE();
  const ticket = auth.issueTicket('user-a');
  const kept = auth.issueTicket('user-b');
  const waiting = auth.createState({ userId: 'user-a', cookieValue }).state;
  const running = auth.consumeState(auth.createState({ userId: 'user-a', cookieValue }).state, cookieValue);
  const others = auth.consumeState(auth.createState({ userId: 'user-b', cookieValue }).state, cookieValue);

  auth.forgetUser('user-a');

  assert.equal(auth.peekTicket(ticket), null);
  assert.equal(auth.consumeState(waiting, cookieValue), null);
  assert.equal(running.end(), false);
  assert.equal(others.end(), true);
  assert.deepEqual(auth.peekTicket(kept), { userId: 'user-b' });
});

test('the code is exchanged at github.com: POST, the secret in the body, JSON asked for, no redirect followed', async () => {
  const answer = tokenAnswer();
  const { auth, calls, clock } = setup({ answer: () => json(answer) });
  const codeVerifier = COOKIE();
  const code = made('code');

  const result = await auth.exchangeCode({ code, codeVerifier });

  assert.deepEqual(result, {
    ok: true,
    tokens: {
      accessToken: answer.access_token,
      expiresAt: clock.at + 28800 * 1000,
      refreshToken: answer.refresh_token,
      refreshExpiresAt: clock.at + 15897600 * 1000,
    },
  });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, 'https://github.com/login/oauth/access_token'); // nothing in the URL
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Accept, 'application/json');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: `${PUBLIC_URL}/api/connectors/github/callback`,
    code_verifier: codeVerifier,
  });
});

test('a code or verifier of another shape is not sent to GitHub', async () => {
  const { auth, calls } = setup({ answer: () => json(tokenAnswer()) });
  for (const code of ['short', 'has space 1234567', `${'c'.repeat(201)}`, undefined, ['c'.repeat(20)]]) {
    assert.deepEqual(await auth.exchangeCode({ code, codeVerifier: COOKIE() }), { ok: false, code: 'bad_request' });
  }
  assert.deepEqual(await auth.exchangeCode({ code: 'c'.repeat(20), codeVerifier: 'x' }), { ok: false, code: 'bad_request' });
  assert.equal(calls.length, 0);
});

test('what GitHub answers to the exchange is rebuilt from known fields or refused', async () => {
  const cases = [
    [() => json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }), 'bad_verification_code'],
    [() => json({ error: 'incorrect_client_credentials' }), 'incorrect_client_credentials'],
    // An error name that is not one of GitHub's documented ones is not repeated
    [() => json({ error: '<script>alert(1)</script>' }), 'refused'],
    [() => json({ error: 42 }), 'refused'],
    [() => json(tokenAnswer(), 500), 'refused'],
    [() => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }), 'bad_response'],
    [() => new Response('<html>not json</html>', { status: 200 }), 'bad_response'],
    [() => json([tokenAnswer()]), 'bad_response'],
    [() => json(tokenAnswer({ access_token: 'has space and is long enough' })), 'bad_response'],
    [() => json(tokenAnswer({ access_token: `ghu_${'a'.repeat(20)}\r\nX-Evil: 1` })), 'bad_response'],
    [() => json(tokenAnswer({ token_type: 'mac' })), 'bad_response'],
    [() => json(tokenAnswer({ expires_in: '28800' })), 'bad_response'],
    [() => json(tokenAnswer({ expires_in: -1 })), 'bad_response'],
    [() => json(tokenAnswer({ refresh_token_expires_in: 1e12 })), 'bad_response'],
    // A token that does not expire has no refresh token: not kept
    [() => json({ access_token: made('ghu'), scope: '', token_type: 'bearer' }), 'bad_response'],
    [() => new Response('x'.repeat(20001), { status: 200 }), 'bad_response'],
    [() => { throw new TypeError('fetch failed'); }, 'unreachable'],
    [() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, 'timeout'],
  ];
  for (const [answer, code] of cases) {
    const { auth } = setup({ answer });
    assert.deepEqual(await auth.exchangeCode({ code: 'c'.repeat(20), codeVerifier: COOKIE() }), { ok: false, code });
  }
});

test('a call that GitHub does not answer in time is given up', async () => {
  const auth = createGithubAuth({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicUrl: PUBLIC_URL,
    timeoutMs: 20,
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.deepEqual(await auth.exchangeCode({ code: 'c'.repeat(20), codeVerifier: COOKIE() }), { ok: false, code: 'timeout' });
});

test('whose token it is: api.github.com/user with the token as Bearer, login and id checked', async () => {
  const accessToken = made('ghu');
  const { auth, calls } = setup({ answer: () => json({ login: 'octo-cat', id: 583231, name: 'ignored', email: 'ignored@example.test' }) });
  assert.deepEqual(await auth.fetchUser(accessToken), { ok: true, login: 'octo-cat', githubUserId: 583231 });
  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.github.com/user');
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(init.headers.Accept, 'application/vnd.github+json');

  const bad = [
    [() => json({ login: '<img src=x>', id: 1 }), 'bad_response'],
    [() => json({ login: 'octo-cat', id: '1' }), 'bad_response'],
    [() => json({ login: 'octo-cat', id: 0 }), 'bad_response'],
    [() => json({ login: `${'a'.repeat(61)}`, id: 1 }), 'bad_response'],
    [() => json(null), 'bad_response'],
    [() => json({ message: 'Bad credentials' }, 401), 'refused'],
    [() => { throw new TypeError('fetch failed'); }, 'unreachable'],
  ];
  for (const [answer, code] of bad) {
    assert.deepEqual(await setup({ answer }).auth.fetchUser(accessToken), { ok: false, code });
  }
  const none = setup({ answer: () => json({}) });
  assert.deepEqual(await none.auth.fetchUser('not a token'), { ok: false, code: 'bad_request' });
  assert.equal(none.calls.length, 0);
});

test('a refresh asks the token endpoint with grant_type refresh_token', async () => {
  const answer = tokenAnswer();
  const { auth, calls, clock } = setup({ answer: () => json(answer) });
  const refreshToken = made('ghr');
  const result = await auth.refresh(refreshToken);
  assert.equal(result.ok, true);
  assert.equal(result.tokens.accessToken, answer.access_token);
  assert.equal(result.tokens.refreshToken, answer.refresh_token);
  assert.equal(result.tokens.expiresAt, clock.at + 28800 * 1000);
  const [{ url, init }] = calls;
  assert.equal(url, 'https://github.com/login/oauth/access_token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refreshToken,
  });
});

test('a refresh says whether GitHub refused it or could not be asked', async () => {
  const refreshToken = made('ghr');
  const refused = [
    [() => json({ error: 'bad_refresh_token' }), 'bad_refresh_token'],
    [() => json({ error: 'something_new' }), 'refused'],
    [() => json({ message: 'no' }, 401), 'refused'],
    [() => json(tokenAnswer({ access_token: 'x' })), 'bad_response'],
  ];
  for (const [answer, code] of refused) {
    assert.deepEqual(await setup({ answer }).auth.refresh(refreshToken), { ok: false, code, refused: true });
  }
  const couldNotAsk = [
    [() => { throw new TypeError('fetch failed'); }, 'unreachable'],
    [() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, 'timeout'],
    [() => new Response('Bad Gateway', { status: 502 }), 'bad_response'],
  ];
  for (const [answer, code] of couldNotAsk) {
    assert.deepEqual(await setup({ answer }).auth.refresh(refreshToken), { ok: false, code, refused: false });
  }
});

test('revoking deletes the grant at api.github.com with the app\'s Basic credentials and the token in the body', async () => {
  const accessToken = made('ghu');
  const { auth, calls } = setup({ answer: () => new Response(null, { status: 204 }) });
  assert.deepEqual(await auth.revokeGrant(accessToken), { ok: true });
  const [{ url, init }] = calls;
  assert.equal(url, `https://api.github.com/applications/${CLIENT_ID}/grant`);
  assert.equal(init.method, 'DELETE');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  assert.deepEqual(JSON.parse(init.body), { access_token: accessToken });

  assert.deepEqual(await setup({ answer: () => json({ message: 'Validation Failed' }, 422) }).auth.revokeGrant(accessToken), { ok: false, code: 'refused' });
  assert.deepEqual(await setup({ answer: () => { throw new TypeError('x'); } }).auth.revokeGrant(accessToken), { ok: false, code: 'unreachable' });
});

test('revoking one token deletes that token, not the grant, with the app\'s Basic credentials', async () => {
  const accessToken = made('ghu');
  const { auth, calls } = setup({ answer: () => new Response(null, { status: 204 }) });
  assert.deepEqual(await auth.revokeToken(accessToken), { ok: true });
  const [{ url, init }] = calls;
  assert.equal(url, `https://api.github.com/applications/${CLIENT_ID}/token`);
  assert.equal(init.method, 'DELETE');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  assert.deepEqual(JSON.parse(init.body), { access_token: accessToken });

  assert.deepEqual(await setup({ answer: () => json({ message: 'Validation Failed' }, 422) }).auth.revokeToken(accessToken), { ok: false, code: 'refused' });
  assert.deepEqual(await setup({ answer: () => { throw new TypeError('x'); } }).auth.revokeToken(accessToken), { ok: false, code: 'unreachable' });
  const none = setup({ answer: () => assert.fail('nothing is sent') });
  assert.deepEqual(await none.auth.revokeToken('not a token'), { ok: false, code: 'bad_request' });
});

test('a token that is not kept is revoked, best effort: a failure is a code in the log and never the token', async () => {
  const accessToken = made('ghu');
  const lines = [];
  const withLog = (answer) => createGithubAuth({
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, publicUrl: PUBLIC_URL, fetch: async (url, init) => answer(String(url), init), log: { warn: (line) => lines.push(line) },
  });
  assert.deepEqual(await withLog(() => new Response(null, { status: 204 })).discardToken(accessToken), { ok: true });
  assert.deepEqual(lines, []);
  assert.deepEqual(await withLog(() => json({ message: `no ${accessToken}` }, 422)).discardToken(accessToken), { ok: false, code: 'refused' });
  assert.deepEqual(await withLog(() => { throw new Error(accessToken); }).discardToken(accessToken), { ok: false, code: 'unreachable' });
  assert.deepEqual(lines, [
    'GitHub: a token that was not kept was not revoked at GitHub (refused)',
    'GitHub: a token that was not kept was not revoked at GitHub (unreachable)',
  ]);
  // A log that throws changes nothing
  const loud = createGithubAuth({
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, publicUrl: PUBLIC_URL, fetch: async () => json({}, 500), log: { warn: () => { throw new Error('boom'); } },
  });
  assert.deepEqual(await loud.discardToken(accessToken), { ok: false, code: 'refused' });
});

test('a token answer that is not kept but holds a token: that token is revoked; one without a token, an error or another status: nothing is', async () => {
  const TOKEN_URL = 'https://github.com/login/oauth/access_token';
  const SINGLE_URL = `https://api.github.com/applications/${CLIENT_ID}/token`;
  const run = async (body, status = 200, how = 'exchange') => {
    const s = setup({ answer: (url) => (url === TOKEN_URL ? json(body, status) : new Response(null, { status: 204 })) });
    const result = how === 'exchange'
      ? await s.auth.exchangeCode({ code: 'c'.repeat(20), codeVerifier: COOKIE() })
      : await s.auth.refresh(made('ghr'));
    await new Promise((resolve) => { setImmediate(resolve); });
    return { result, revoked: s.calls.filter((call) => call.url === SINGLE_URL).map((call) => JSON.parse(call.init.body)), calls: s.calls };
  };
  // The app's tokens do not expire: no refresh token, no expiry
  const forever = made('ghu');
  const noRefresh = await run({ access_token: forever, scope: '', token_type: 'bearer' });
  assert.deepEqual(noRefresh.result, { ok: false, code: 'bad_response' });
  assert.deepEqual(noRefresh.revoked, [{ access_token: forever }]);
  assert.equal(noRefresh.calls.length, 2);
  // Also when a refresh is answered that way: the token it issued is nobody's
  const viaRefresh = await run({ access_token: forever, scope: '', token_type: 'bearer' }, 200, 'refresh');
  assert.equal(viaRefresh.result.code, 'bad_response');
  assert.deepEqual(viaRefresh.revoked, [{ access_token: forever }]);
  const badLifetime = await run(tokenAnswer({ access_token: forever, expires_in: -1 }));
  assert.deepEqual(badLifetime.revoked, [{ access_token: forever }]);

  // Nothing to revoke, or nothing that is a token: GitHub is not asked
  for (const [body, status] of [
    [{ error: 'bad_verification_code' }, 200],
    [tokenAnswer(), 500],
    [tokenAnswer({ access_token: 'has space and is long enough' }), 200],
    [{ scope: '', token_type: 'bearer' }, 200],
    [[tokenAnswer()], 200],
  ]) {
    const none = await run(body, status);
    assert.equal(none.result.ok, false);
    assert.deepEqual(none.revoked, [], JSON.stringify(body));
  }
  // An answer that is kept is not revoked
  const kept = await run(tokenAnswer());
  assert.equal(kept.result.ok, true);
  assert.deepEqual(kept.revoked, []);
});

test('an undo is 32 random bytes, names its user, works once, for ten minutes, one per user', () => {
  const { auth, clock } = setup();
  const value = auth.createUndo('user-a');
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(auth.createUndo('user-b'), value);
  assert.deepEqual(auth.consumeUndo(value), { userId: 'user-a' });
  assert.equal(auth.consumeUndo(value), null);
  for (const bad of [undefined, null, 42, '', 'x', `${value}x`, COOKIE(), { toString: () => value }]) assert.equal(auth.consumeUndo(bad), null);
  assert.equal(auth.createUndo(''), null);
  assert.equal(auth.createUndo(undefined), null);

  // Ten minutes
  const late = auth.createUndo('user-a');
  clock.at += 10 * 60 * 1000;
  assert.equal(auth.consumeUndo(late), null);
  const inTime = auth.createUndo('user-a');
  clock.at += 10 * 60 * 1000 - 1;
  assert.deepEqual(auth.consumeUndo(inTime), { userId: 'user-a' });

  // A new connect ends the undo of the one before, and nobody else's
  const [first, other] = [auth.createUndo('user-a'), auth.createUndo('user-c')];
  const second = auth.createUndo('user-a');
  assert.equal(auth.consumeUndo(first), null);
  assert.deepEqual(auth.consumeUndo(other), { userId: 'user-c' });
  // The connection ended (disconnect, logout): its undo goes too
  auth.forgetUser('user-a');
  assert.equal(auth.consumeUndo(second), null);
});

test('every call goes to github.com or api.github.com over https', async () => {
  const { auth, calls } = setup({ answer: () => json(tokenAnswer()) });
  await auth.exchangeCode({ code: 'c'.repeat(20), codeVerifier: COOKIE() });
  await auth.refresh(made('ghr'));
  await auth.fetchUser(made('ghu'));
  await auth.revokeGrant(made('ghu'));
  assert.equal(calls.length, 4);
  for (const { url } of calls) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'https:');
    assert.ok(['github.com', 'api.github.com'].includes(parsed.hostname));
    assert.equal(parsed.search, '');
  }
});
