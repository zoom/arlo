// "Connect GitHub" over HTTP: the ticket, the two pages, GitHub's redirect
// back, disconnect, logout and app removal. GitHub is a made-up fetch and the
// clock is made up: nothing here touches the network.
const h = require('./helpers');
const crypto = require('node:crypto');

// Made up for this run
const CLIENT_ID = 'Iv1.arlotestclient02';
const CLIENT_SECRET = crypto.randomBytes(20).toString('hex');
const REPO = 'example-org/arlo-demo';
h.setTestEnv({
  RTMS_SERVICE_URL: 'http://127.0.0.1:9',
  GITHUB_DEFAULT_REPO: REPO,
  GITHUB_APP_CLIENT_ID: CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken, encryptToken, decryptToken } = require('../src/services/auth');
const githubAuth = require('../src/services/connectors/githubAuth');
const githubConnections = require('../src/services/connectors/githubConnections');
const deauthorized = require('../src/lib/deauthorized');

const ORIGIN = 'https://arlo.example.test';
const made = (prefix) => `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
const HOUR = 60 * 60 * 1000;

// Everything the server prints while these tests run, and every secret that
// passed through them: at the end none of the second may be in the first
const logged = [];
const secrets = new Set([CLIENT_SECRET]);
for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
  console[method] = (...args) => logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
}
const secret = (value) => { secrets.add(value); return value; };

// GitHub, made up: answers by URL, and remembers what it was asked
const clock = { at: Date.now() };
const github = { calls: [], answers: {} };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function githubAnswers({ login = 'octo-cat', id = 583231, token, user, revoke } = {}) {
  const tokens = {
    access_token: secret(made('ghu')), expires_in: 28800, refresh_token: secret(made('ghr')),
    refresh_token_expires_in: 15897600, scope: '', token_type: 'bearer',
  };
  github.calls = [];
  github.answers = {
    'https://github.com/login/oauth/access_token': token || (() => json(tokens)),
    'https://api.github.com/user': user || (() => json({ login, id })),
    [`https://api.github.com/applications/${CLIENT_ID}/grant`]: revoke || (() => new Response(null, { status: 204 })),
  };
  secrets.add(login);
  return tokens;
}
const fakeFetch = async (url, init) => {
  github.calls.push({ url: String(url), init });
  const answer = github.answers[String(url)];
  if (!answer) throw new TypeError(`unexpected call to ${url}`);
  return answer(init);
};

let srv;
test.before(async () => {
  srv = await h.startServer();
  githubAuth._setForTests(githubAuth.createGithubAuth({
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, publicUrl: ORIGIN, fetch: fakeFetch, now: () => clock.at,
  }));
  githubConnections._setForTests(githubConnections.createGithubConnections({
    encrypt: encryptToken,
    decrypt: decryptToken,
    refresh: (refreshToken) => githubAuth.getGithubAuth().refresh(refreshToken),
    now: () => clock.at,
  }));
});
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });
// The auth limiter counts per client address (120 per 15 minutes). Each test
// is a client of its own, as the proxy in front of the server would report it
let client = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, { ...init, headers: { ...init.headers, 'x-forwarded-for': `10.20.30.${client}` } });
test.beforeEach(() => { client += 1; githubAnswers(); });

let people = 0;
function person(displayName) {
  people += 1;
  const zoomUserId = `zoom-gh-connect-${people}`;
  const user = userStore.upsert(zoomUserId, { email: `${zoomUserId}@example.test`, displayName, avatarUrl: null });
  secret(user.id);
  const token = generateToken({ userId: user.id, zoomUserId, exp: Date.now() + HOUR });
  return { user, zoomUserId, session: `sessionToken=${token}` };
}

const api = (path) => `${srv.base}/api/connectors${path}`;
const connectors = async (who) => {
  const res = await fetch(api(''), { headers: who ? { cookie: who.session } : {} });
  return { status: res.status, body: await res.json(), headers: res.headers };
};
const askTicket = (who, body = {}, headers = {}) => h.postJson(api('/github/ticket'), body, { ...(who ? { cookie: who.session } : {}), ...headers });
async function ticketFor(who) {
  const { status, body } = await askTicket(who);
  assert.equal(status, 200);
  const url = new URL(body.url);
  return secret(url.searchParams.get('ticket'));
}
/** GET the start page as a browser without an Arlo session. */
async function openStart(ticket) {
  const res = await fetch(api(`/github/start${ticket === undefined ? '' : `?ticket=${encodeURIComponent(ticket)}`}`));
  const setCookie = res.headers.get('set-cookie') || '';
  const value = (setCookie.match(/^ghConnect=([^;]*)/) || [])[1];
  return {
    status: res.status, html: await res.text(), headers: res.headers, setCookie, ghCookie: value ? secret(value) : undefined,
  };
}
/** The click on "Continue to GitHub". */
async function click(ticket, ghCookie, { origin = ORIGIN, contentType = 'application/x-www-form-urlencoded', body } = {}) {
  const res = await fetch(api('/github/start'), {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': contentType,
      ...(origin ? { origin } : {}),
      ...(ghCookie ? { cookie: `ghConnect=${ghCookie}` } : {}),
    },
    body: body === undefined ? new URLSearchParams({ ticket }).toString() : body,
  });
  const location = res.headers.get('location');
  const state = location ? new URL(location).searchParams.get('state') : null;
  return {
    status: res.status, html: await res.text(), headers: res.headers, location, state: state ? secret(state) : null,
  };
}
/** GitHub's redirect back, in the browser that holds `ghCookie`. */
async function callbackAs(query, ghCookie) {
  const res = await fetch(`${api('/github/callback')}?${new URLSearchParams(query)}`, {
    headers: ghCookie ? { cookie: `ghConnect=${ghCookie}` } : {},
  });
  return {
    status: res.status, html: await res.text(), headers: res.headers, setCookie: res.headers.get('set-cookie') || '',
  };
}
const callback = callbackAs;
/** Everything up to GitHub's page: { ghCookie, state }. */
async function upToGithub(who) {
  const ticket = await ticketFor(who);
  const { ghCookie } = await openStart(ticket);
  const { state } = await click(ticket, ghCookie);
  return { ticket, ghCookie, state };
}
async function connect(who, answers) {
  const tokens = githubAnswers(answers);
  const { ghCookie, state } = await upToGithub(who);
  const code = secret(made('code'));
  const result = await callback({ code, state }, ghCookie);
  return {
    ...result, tokens, code, state, ghCookie,
  };
}

const EXPIRED = 'This link has expired. Start again from Arlo\'s settings.';
const NOT_CONNECTED = 'GitHub was not connected. Start again from Arlo\'s settings.';
const CONNECTED = 'GitHub is connected. You can close this tab and go back to Zoom.';
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

function assertPage(res, csp = PAGE_CSP) {
  assert.match(res.headers.get('content-type'), /^text\/html; charset=utf-8/);
  assert.equal(res.headers.get('content-security-policy'), csp);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(/<script/i.test(res.html), false);
  assert.equal(/\son[a-z]+=/i.test(res.html), false);
}
const failedCodes = () => logged.filter((line) => line.startsWith('GitHub connect failed')).map((line) => line.match(/\((.*)\)$/)[1]);

test('the whole flow: ticket, start page, GitHub, callback, connected', async () => {
  const ana = person('Ana Ruiz');
  assert.deepEqual((await connectors(ana)).body, { github: { available: true, connected: false, login: null } });

  // 1. The signed-in panel asks for a link
  const asked = await askTicket(ana);
  assert.equal(asked.status, 200);
  assert.deepEqual(Object.keys(asked.body), ['url']);
  assert.match(asked.body.url, /^https:\/\/arlo\.example\.test\/api\/connectors\/github\/start\?ticket=[A-Za-z0-9_-]{43}$/);
  const ticket = secret(new URL(asked.body.url).searchParams.get('ticket'));

  // 2. The browser, which has no Arlo session, shows whose Arlo it is
  const start = await openStart(ticket);
  assert.equal(start.status, 200);
  assertPage(start, "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'");
  assert.match(start.html, /Connect a GitHub account to Arlo for <strong>Ana Ruiz<\/strong>/);
  assert.match(start.html, /<form method="post" action="\/api\/connectors\/github\/start">/);
  assert.match(start.html, /<button type="submit">Continue to GitHub<\/button>/);
  assert.match(start.html, /Not you\? Close this tab\./);
  assert.match(start.ghCookie, /^[A-Za-z0-9_-]{43}$/);
  assert.match(start.setCookie, /; Max-Age=600; Path=\/api\/connectors\/github; /);
  assert.match(start.setCookie, /; HttpOnly/);
  assert.match(start.setCookie, /; Secure/);
  assert.match(start.setCookie, /; SameSite=Lax/);

  // 3. The click: a redirect to GitHub that the server built
  const clicked = await click(ticket, start.ghCookie);
  assert.equal(clicked.status, 303);
  const to = new URL(clicked.location);
  assert.equal(`${to.origin}${to.pathname}`, 'https://github.com/login/oauth/authorize');
  assert.equal(to.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/api/connectors/github/callback`);
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('prompt'), 'select_account');
  assert.match(clicked.state, /^[A-Za-z0-9_-]{43}$/);
  for (const hidden of [ticket, start.ghCookie, CLIENT_SECRET, ana.user.id]) assert.equal(clicked.location.includes(hidden), false);
  assert.equal(github.calls.length, 0);

  // 4. GitHub sends the browser back
  const tokens = githubAnswers({ login: 'ana-on-github' });
  const code = secret(made('code'));
  const back = await callback({ code, state: clicked.state }, start.ghCookie);
  assert.equal(back.status, 200);
  assertPage(back);
  assert.ok(back.html.includes(CONNECTED));
  assert.match(back.setCookie, /^ghConnect=;/); // cleared
  assert.match(back.setCookie, /Path=\/api\/connectors\/github/);

  // The code was exchanged with the verifier of the challenge that was sent
  const exchange = github.calls.find((call) => call.url === 'https://github.com/login/oauth/access_token');
  const sent = Object.fromEntries(new URLSearchParams(exchange.init.body));
  assert.equal(sent.code, code);
  assert.equal(sent.client_secret, CLIENT_SECRET);
  assert.equal(crypto.createHash('sha256').update(sent.code_verifier).digest('base64url'), to.searchParams.get('code_challenge'));
  assert.equal(github.calls.find((call) => call.url === 'https://api.github.com/user').init.headers.Authorization, `Bearer ${tokens.access_token}`);

  // 5. Connected, for this user
  assert.deepEqual((await connectors(ana)).body, { github: { available: true, connected: true, login: 'ana-on-github' } });
  assert.equal(await githubConnections.getGithubConnections().getAccessToken(ana.user.id), tokens.access_token);
  assert.ok(logged.includes('GitHub connected'));

  // No page told the browser anything it must not know
  for (const html of [start.html, clicked.html, back.html]) {
    for (const hidden of [code, clicked.state, tokens.access_token, tokens.refresh_token, CLIENT_SECRET, ana.user.id, 'ana-on-github']) {
      assert.equal(html.includes(hidden), false);
    }
  }
  assert.equal(back.html.includes(ticket), false);
});

test('GET /api/connectors is for a signed-in caller, about the caller only, and never holds a token', async () => {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  const { tokens } = await connect(ana, { login: 'ana-gh' });

  assert.equal((await connectors(null)).status, 401);
  const mine = await connectors(ana);
  assert.equal(mine.headers.get('cache-control'), 'no-store');
  assert.equal(mine.headers.get('ratelimit-limit'), '120'); // the auth limiter
  assert.deepEqual(mine.body, { github: { available: true, connected: true, login: 'ana-gh' } });
  const text = JSON.stringify(mine.body);
  for (const hidden of [tokens.access_token, tokens.refresh_token, CLIENT_SECRET]) assert.equal(text.includes(hidden), false);
  // Ben learns nothing of Ana's connection
  assert.deepEqual((await connectors(ben)).body, { github: { available: true, connected: false, login: null } });
});

test('a ticket is only for a signed-in caller who sends an empty JSON object', async () => {
  const ana = person('Ana Ruiz');
  assert.equal((await askTicket(null)).status, 401);
  assert.equal((await askTicket(ana, { userId: 'someone-else' })).status, 400);
  assert.equal((await askTicket(ana, [])).status, 400);
  const form = await fetch(api('/github/ticket'), {
    method: 'POST', headers: { cookie: ana.session, 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(form.status, 415);
  const ok = await fetch(api('/github/ticket'), {
    method: 'POST', headers: { cookie: ana.session, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  secret(new URL((await ok.json()).url).searchParams.get('ticket'));
});

test('the start page: an unknown, malformed, missing or expired ticket is the same expired page', async () => {
  const ana = person('Ana Ruiz');
  const unknown = crypto.randomBytes(32).toString('base64url');
  for (const ticket of [unknown, 'short', `${'a'.repeat(43)}"><script>alert(1)</script>`, undefined, '']) {
    const res = await openStart(ticket);
    assert.equal(res.status, 400);
    assertPage(res);
    assert.ok(res.html.includes(EXPIRED));
    assert.equal(res.setCookie, '');
    if (ticket) assert.equal(res.html.includes(ticket), false);
  }
  const ticket = await ticketFor(ana);
  clock.at += 5 * 60 * 1000;
  const late = await openStart(ticket);
  assert.equal(late.status, 400);
  assert.ok(late.html.includes(EXPIRED));
  clock.at = Date.now();
});

test('opening the start page does not use the ticket up; the click does, once', async () => {
  const ana = person('Ana Ruiz');
  const ticket = await ticketFor(ana);
  const first = await openStart(ticket);
  const second = await openStart(ticket); // a link preview, a reload
  assert.equal(second.status, 200);
  assert.notEqual(first.ghCookie, second.ghCookie);

  assert.equal((await click(ticket, second.ghCookie)).status, 303);
  const again = await click(ticket, second.ghCookie);
  assert.equal(again.status, 400);
  assert.ok(again.html.includes(EXPIRED));
  assert.equal(again.location, null);
  assert.equal((await openStart(ticket)).status, 400);
});

test('a user holds at most three open tickets', async () => {
  const ana = person('Ana Ruiz');
  const tickets = [];
  for (let i = 0; i < 4; i += 1) tickets.push(await ticketFor(ana));
  assert.equal((await openStart(tickets[0])).status, 400);
  for (const ticket of tickets.slice(1)) assert.equal((await openStart(ticket)).status, 200);
});

test('a display name is shown as text: markup in it is escaped', async () => {
  const eve = person('<script>alert(1)</script> & "Eve" <b>');
  const res = await openStart(await ticketFor(eve));
  assert.equal(res.status, 200);
  assertPage(res, "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'");
  assert.ok(res.html.includes('<strong>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Eve&quot; &lt;b&gt;</strong>'));
  assert.equal(res.html.includes('<b>'), false);

  // Cut to 60 characters, and a name that cannot be shown is not shown
  const long = person('N'.repeat(80));
  assert.ok((await openStart(await ticketFor(long))).html.includes(`<strong>${'N'.repeat(60)}</strong>`));
  const blank = person('‮evil');
  const page = await openStart(await ticketFor(blank));
  assert.ok(page.html.includes('Connect a GitHub account to Arlo for the person who opened this page from Arlo'));
  assert.equal(page.html.includes('‮'), false);
});

test('the click is refused from another origin, without the cookie, or in another shape, and does not use the ticket up', async () => {
  const ana = person('Ana Ruiz');
  const ticket = await ticketFor(ana);
  const { ghCookie } = await openStart(ticket);
  const form = new URLSearchParams({ ticket }).toString();

  const refusals = [
    [await click(ticket, ghCookie, { origin: 'https://evil.example.test' }), 403],
    [await click(ticket, ghCookie, { origin: null }), 403],
    [await click(ticket, ghCookie, { origin: 'null' }), 403],
    [await click(ticket, undefined), 400],
    [await click(ticket, 'not-the-cookie-shape'), 400],
    [await click(ticket, ghCookie, { contentType: 'application/json', body: JSON.stringify({ ticket }) }), 400],
    [await click(ticket, ghCookie, { body: `${form}&extra=1` }), 400],
    [await click(ticket, ghCookie, { body: 'ticket[]=x' }), 400],
    [await click(ticket, ghCookie, { body: '' }), 400],
  ];
  for (const [res, status] of refusals) {
    assert.equal(res.status, status);
    assert.equal(res.location, null);
    assertPage(res);
    assert.ok(res.html.includes(EXPIRED));
  }
  // The page's own click still works
  assert.equal((await click(ticket, ghCookie)).status, 303);
});

test('the callback: a state works once', async () => {
  const ana = person('Ana Ruiz');
  const first = await connect(ana);
  assert.equal(first.status, 200);
  github.calls = [];
  const replay = await callback({ code: secret(made('code')), state: first.state }, first.ghCookie);
  assert.equal(replay.status, 400);
  assertPage(replay);
  assert.ok(replay.html.includes(NOT_CONNECTED));
  assert.equal(github.calls.length, 0);
  assert.equal(failedCodes().pop(), 'bad_state');
});

test('the callback: wrong cookie, no cookie, expired, unknown and malformed are all "not connected", and nothing is kept', async () => {
  const ana = person('Ana Ruiz');
  const code = () => secret(made('code'));
  let noted = () => {};
  // eslint-disable-next-line no-shadow
  const callback = (query, ghCookie) => { noted(query); return callbackAs(query, ghCookie); };
  const tries = [
    ['bad_state', async ({ state }) => callback({ code: code(), state }, secret(crypto.randomBytes(32).toString('base64url')))],
    ['bad_state', async ({ state }) => callback({ code: code(), state }, undefined)],
    ['bad_state', async ({ state, ghCookie }) => { clock.at += 10 * 60 * 1000; return callback({ code: code(), state }, ghCookie); }],
    ['bad_state', async ({ ghCookie }) => callback({ code: code(), state: secret(crypto.randomBytes(32).toString('base64url')) }, ghCookie)],
    ['bad_request', async ({ ghCookie }) => callback({ code: code(), state: 'short' }, ghCookie)],
    ['bad_request', async ({ state, ghCookie }) => callback({ code: 'no', state }, ghCookie)],
    ['bad_request', async ({ state, ghCookie }) => callback({ code: 'has spaces in it and more', state }, ghCookie)],
    ['bad_request', async ({ state, ghCookie }) => callback({ state }, ghCookie)],
    ['bad_request', async ({ ghCookie }) => callback({ code: code() }, ghCookie)],
    ['denied', async ({ state, ghCookie }) => callback({ error: 'access_denied', error_description: 'The user has denied', state }, ghCookie)],
  ];
  for (const [expected, attempt] of tries) {
    const flow = await upToGithub(ana);
    github.calls = [];
    let lastQuery = null;
    const sentState = (f) => lastQuery !== null && lastQuery.state === f.state;
    noted = (query) => { if (lastQuery === null) lastQuery = query; };
    const res = await attempt(flow);
    clock.at = Date.now();
    assert.equal(res.status, 400, expected);
    assertPage(res);
    assert.ok(res.html.includes(NOT_CONNECTED));
    assert.equal(failedCodes().pop(), expected);
    assert.equal(github.calls.length, 0);
    // A state that was sent is spent by the attempt, also by one that was refused
    if (sentState(flow)) {
      const after = await callback({ code: code(), state: flow.state }, flow.ghCookie);
      assert.equal(after.status, 400);
    }
  }
  assert.deepEqual((await connectors(ana)).body.github, { available: true, connected: false, login: null });
});

test('the callback: whatever GitHub answers badly ends as "not connected" with a code, and nothing is kept', async () => {
  const ana = person('Ana Ruiz');
  const bad = [
    ['bad_verification_code', { token: () => json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }) }],
    ['refused', { token: () => json({ error: 'some <b>new</b> thing' }) }],
    ['bad_response', { token: () => json({ access_token: made('gho'), token_type: 'bearer', scope: '' }) }],
    ['bad_response', { token: () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }) }],
    ['unreachable', { token: () => { throw new TypeError('fetch failed'); } }],
    ['timeout', { token: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }],
    ['refused', { user: () => json({ message: 'Bad credentials' }, 401) }],
    ['bad_response', { user: () => json({ login: '<img src=x onerror=alert(1)>', id: 1 }) }],
    ['unreachable', { user: () => { throw new TypeError('fetch failed'); } }],
  ];
  for (const [expected, answers] of bad) {
    const res = await connect(ana, answers);
    assert.equal(res.status, 400, expected);
    assertPage(res);
    assert.ok(res.html.includes(NOT_CONNECTED));
    assert.equal(res.html.includes('evil'), false);
    assert.match(res.setCookie, /^ghConnect=;/);
    assert.equal(failedCodes().pop(), expected);
  }
  assert.deepEqual((await connectors(ana)).body.github, { available: true, connected: false, login: null });
  assert.equal(await githubConnections.getGithubConnections().getAccessToken(ana.user.id), null);
});

test('a callback for one user never connects another', async () => {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  const flowA = await upToGithub(ana);
  const flowB = await upToGithub(ben);

  // Ben's browser with Ana's state, and the other way round: neither works
  assert.equal((await callback({ code: secret(made('code')), state: flowA.state }, flowB.ghCookie)).status, 400);
  const benTokens = githubAnswers({ login: 'ben-gh', id: 22 });
  assert.equal((await callback({ code: secret(made('code')), state: flowB.state }, flowB.ghCookie)).status, 200);

  assert.deepEqual((await connectors(ben)).body.github, { available: true, connected: true, login: 'ben-gh' });
  assert.deepEqual((await connectors(ana)).body.github, { available: true, connected: false, login: null });
  const store = githubConnections.getGithubConnections();
  assert.equal(await store.getAccessToken(ben.user.id), benTokens.access_token);
  assert.equal(await store.getAccessToken(ana.user.id), null);

  // Ana connects as someone else: each keeps their own
  const anaConnected = await connect(ana, { login: 'ana-gh', id: 11 });
  assert.equal(await store.getAccessToken(ana.user.id), anaConnected.tokens.access_token);
  assert.equal(await store.getAccessToken(ben.user.id), benTokens.access_token);
  assert.equal((await connectors(ben)).body.github.login, 'ben-gh');
});

test('connected: that user\'s own panels are told, with no content, and nobody else\'s', async () => {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  const meetingId = 'GH-CONNECT-WS==';
  const pass = async (session) => (await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
    session ? { cookie: session } : {},
  )).cookie;
  const open = async (session) => {
    const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, { cookie: [await pass(session), session].filter(Boolean).join('; ') });
    assert.equal(ws.open, true);
    return ws;
  };
  const [anaPanel, benPanel, guestPanel] = [await open(ana.session), await open(ben.session), await open(null)];

  assert.equal((await connect(ana, { login: 'ana-gh' })).status, 200);
  await h.wait(100);

  const updates = (ws) => ws.messages.filter((msg) => msg.type === 'connectors.updated');
  assert.deepEqual(updates(anaPanel), [{ type: 'connectors.updated' }]);
  assert.deepEqual(updates(benPanel), []);
  assert.deepEqual(updates(guestPanel), []);
  for (const ws of [anaPanel, benPanel, guestPanel]) ws.socket.close();
});

test('disconnect forgets the caller\'s connection and revokes the grant at GitHub', async () => {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  const { tokens } = await connect(ana, { login: 'ana-gh' });
  const benConnected = await connect(ben, { login: 'ben-gh', id: 22 });
  githubAnswers();

  assert.equal((await fetch(api('/github'), { method: 'DELETE' })).status, 401);
  const res = await fetch(api('/github'), { method: 'DELETE', headers: { cookie: ana.session } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { connected: false });

  assert.equal(github.calls.length, 1);
  const [{ url, init }] = github.calls;
  assert.equal(url, `https://api.github.com/applications/${CLIENT_ID}/grant`);
  assert.equal(init.method, 'DELETE');
  assert.deepEqual(JSON.parse(init.body), { access_token: tokens.access_token });
  assert.ok(logged.includes('GitHub disconnected'));

  assert.deepEqual((await connectors(ana)).body.github, { available: true, connected: false, login: null });
  assert.equal(await githubConnections.getGithubConnections().getAccessToken(ben.user.id), benConnected.tokens.access_token);

  // Not connected: nothing to revoke, the same answer
  github.calls = [];
  const again = await fetch(api('/github'), { method: 'DELETE', headers: { cookie: ana.session } });
  assert.deepEqual(await again.json(), { connected: false });
  assert.equal(github.calls.length, 0);
});

test('disconnect: when GitHub does not revoke, the connection is gone here all the same', async () => {
  const ana = person('Ana Ruiz');
  await connect(ana);
  githubAnswers({ revoke: () => json({ message: 'Validation Failed' }, 422) });
  const res = await fetch(api('/github'), { method: 'DELETE', headers: { cookie: ana.session } });
  assert.deepEqual(await res.json(), { connected: false });
  assert.equal((await connectors(ana)).body.github.connected, false);
  assert.ok(logged.includes('GitHub disconnect: the grant was not revoked at GitHub (refused)'));
});

/** Open panels in one meeting for these sessions (null: a guest). */
async function panelsIn(meetingId, sessions) {
  const pass = async (session) => (await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
    session ? { cookie: session } : {},
  )).cookie;
  const panels = [];
  for (const session of sessions) {
    const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, { cookie: [await pass(session), session].filter(Boolean).join('; ') });
    assert.equal(ws.open, true);
    panels.push(ws);
  }
  return panels;
}
const updatesOn = (ws) => ws.messages.filter((msg) => msg.type === 'connectors.updated');
const revokes = () => github.calls.filter((call) => call.url === `https://api.github.com/applications/${CLIENT_ID}/grant`);

test('disconnect: that user\'s own panels are told, and nobody else\'s', async () => {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  await connect(ana, { login: 'ana-gh' });
  const [anaPanel, benPanel, guestPanel] = await panelsIn('GH-DISCONNECT-WS==', [ana.session, ben.session, null]);
  const res = await fetch(api('/github'), { method: 'DELETE', headers: { cookie: ana.session } });
  assert.deepEqual(await res.json(), { connected: false });
  await h.wait(100);
  assert.deepEqual(updatesOn(anaPanel), [{ type: 'connectors.updated' }]);
  assert.deepEqual(updatesOn(benPanel), []);
  assert.deepEqual(updatesOn(guestPanel), []);
  // not connected: nothing changed, nobody is told again
  await fetch(api('/github'), { method: 'DELETE', headers: { cookie: ana.session } });
  await h.wait(50);
  assert.equal(updatesOn(anaPanel).length, 1);
  for (const ws of [anaPanel, benPanel, guestPanel]) ws.socket.close();
});

test('a connection GitHub ends (a refused refresh) is told to that user\'s panels: the running server\'s own store does it', async () => {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  const testStore = githubConnections.getGithubConnections();
  // The store the server builds for itself: the real clock, and its own way of telling the panels
  githubConnections._setForTests(undefined);
  try {
    const store = githubConnections.getGithubConnections();
    assert.notEqual(store, testStore);
    const record = (login) => ({
      accessToken: secret(made('ghu')), expiresAt: Date.now() + 1000, refreshToken: secret(made('ghr')), refreshExpiresAt: Date.now() + HOUR, login, githubUserId: 7,
    });
    assert.equal(store.set(ana.user.id, record('ana-gh')), true);
    assert.equal(store.set(ben.user.id, { ...record('ben-gh'), expiresAt: Date.now() + HOUR }), true);
    const [anaPanel, benPanel] = await panelsIn('GH-REFUSED-WS==', [ana.session, ben.session]);
    githubAnswers({ token: () => json({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }) });
    assert.equal(await store.getAccessToken(ana.user.id), null);
    await h.wait(100);
    assert.deepEqual(updatesOn(anaPanel), [{ type: 'connectors.updated' }]);
    assert.deepEqual(updatesOn(benPanel), []);
    assert.deepEqual((await connectors(ana)).body.github, { available: true, connected: false, login: null });
    assert.equal((await connectors(ben)).body.github.connected, true);
    store.remove(ben.user.id);
    for (const ws of [anaPanel, benPanel]) ws.socket.close();
  } finally {
    githubConnections._setForTests(testStore);
  }
});

test('logout also asks GitHub to delete the grant, and does not wait for it', async () => {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  const { tokens } = await connect(ana, { login: 'ana-gh' });
  await connect(ben, { login: 'ben-gh', id: 22 });
  let answerRevoke;
  const asked = new Promise((resolve) => {
    githubAnswers({ revoke: () => { resolve(); return new Promise((done) => { answerRevoke = done; }); } });
  });
  const out = await h.postJson(`${srv.base}/api/auth/logout`, {}, { cookie: ana.session });
  // signed out while GitHub has not answered yet
  assert.equal(out.status, 200);
  assert.equal(githubConnections.getGithubConnections().status(ana.user.id).connected, false);
  await asked;
  assert.equal(revokes().length, 1);
  const [{ init }] = revokes();
  assert.equal(init.method, 'DELETE');
  assert.deepEqual(JSON.parse(init.body), { access_token: tokens.access_token });
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  // GitHub says no in the end: logged as a code, and nothing else changes
  answerRevoke(json({ message: 'Validation Failed' }, 422));
  await h.wait(50);
  assert.ok(logged.includes('GitHub disconnect: the grant was not revoked at GitHub (refused)'));
  assert.equal(githubConnections.getGithubConnections().status(ben.user.id).connected, true);

  // someone who never connected: GitHub is not asked
  const cy = person('Cy Young');
  githubAnswers();
  assert.equal((await h.postJson(`${srv.base}/api/auth/logout`, {}, { cookie: cy.session })).status, 200);
  await h.wait(50);
  assert.equal(github.calls.length, 0);
});

test('logout when GitHub cannot be reached: signed out all the same, the connection gone, a code logged', async () => {
  const ana = person('Ana Ruiz');
  await connect(ana);
  githubAnswers({ revoke: () => { throw new TypeError('fetch failed'); } });
  assert.equal((await h.postJson(`${srv.base}/api/auth/logout`, {}, { cookie: ana.session })).status, 200);
  await h.wait(50);
  assert.equal(githubConnections.getGithubConnections().status(ana.user.id).connected, false);
  assert.ok(logged.includes('GitHub disconnect: the grant was not revoked at GitHub (unreachable)'));
});

test('removing the app (app_deauthorized) also asks GitHub to delete the grant', async () => {
  const ana = person('Ana Ruiz');
  const { tokens } = await connect(ana);
  githubAnswers();
  const res = await h.postWebhook(srv.base, {
    event: 'app_deauthorized',
    payload: {
      account_id: 'acct-1', user_id: ana.zoomUserId, signature: 'uninstall-2', deauthorization_time: new Date().toISOString(), client_id: 'test-client-id',
    },
  });
  assert.equal(res.status, 200);
  await h.wait(50);
  assert.equal(revokes().length, 1);
  assert.deepEqual(JSON.parse(revokes()[0].init.body), { access_token: tokens.access_token });
  assert.equal(githubConnections.getGithubConnections().status(ana.user.id).connected, false);
  deauthorized._resetForTests();
});

test('disconnect with a token that has run out: it is refreshed first, and the new one is what GitHub is asked to revoke', async () => {
  const ana = person('Ana Ruiz');
  const { tokens } = await connect(ana);
  const next = githubAnswers();
  const before = clock.at;
  clock.at += 9 * HOUR;
  try {
    // The store's clock says the token ran out; the route's own check uses the real time,
    // so the stored expiry is put in the past as well
    const store = githubConnections.getGithubConnections();
    const held = store.take(ana.user.id);
    assert.equal(held.accessToken, tokens.access_token);
    store.set(ana.user.id, {
      ...held, expiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 1000 * HOUR, login: 'octo-cat', githubUserId: 583231,
    });
    const res = await fetch(api('/github'), { method: 'DELETE', headers: { cookie: ana.session } });
    assert.deepEqual(await res.json(), { connected: false });
    const exchange = github.calls.find((call) => call.url === 'https://github.com/login/oauth/access_token');
    assert.equal(new URLSearchParams(exchange.init.body).get('grant_type'), 'refresh_token');
    assert.equal(new URLSearchParams(exchange.init.body).get('refresh_token'), tokens.refresh_token);
    assert.deepEqual(JSON.parse(revokes()[0].init.body), { access_token: next.access_token });
    assert.equal(store.status(ana.user.id).connected, false);
  } finally {
    clock.at = before;
  }
});

test('logout removes the user\'s GitHub connection, and a flow they had started connects nothing', async () => {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  await connect(ana);
  const benConnected = await connect(ben, { login: 'ben-gh', id: 22 });
  const store = githubConnections.getGithubConnections();
  const open = await upToGithub(ana);
  const ticket = await ticketFor(ana);

  const out = await h.postJson(`${srv.base}/api/auth/logout`, {}, { cookie: ana.session });
  assert.equal(out.status, 200);

  assert.deepEqual(store.status(ana.user.id), { connected: false, login: null });
  assert.equal(await store.getAccessToken(ana.user.id), null);
  assert.equal(await store.getAccessToken(ben.user.id), benConnected.tokens.access_token);
  // What was open is closed
  assert.equal((await callback({ code: secret(made('code')), state: open.state }, open.ghCookie)).status, 400);
  assert.equal((await openStart(ticket)).status, 400);
  assert.equal(store.status(ana.user.id).connected, false);
});

test('a user who signs out while GitHub is being asked is not connected after all', async () => {
  const ana = person('Ana Ruiz');
  const { ghCookie, state } = await upToGithub(ana);
  githubAnswers({
    user: async () => {
      await h.postJson(`${srv.base}/api/auth/logout`, {}, { cookie: ana.session });
      return json({ login: 'ana-gh', id: 11 });
    },
  });
  const res = await callback({ code: secret(made('code')), state }, ghCookie);
  assert.equal(res.status, 400);
  assert.ok(res.html.includes(NOT_CONNECTED));
  assert.equal(failedCodes().pop(), 'user_gone');
  assert.equal(githubConnections.getGithubConnections().status(ana.user.id).connected, false);
});

test('removing the app (app_deauthorized) removes the user\'s GitHub connection', async () => {
  const ana = person('Ana Ruiz');
  const ben = person('Ben Okafor');
  await connect(ana);
  await connect(ben, { login: 'ben-gh', id: 22 });
  const store = githubConnections.getGithubConnections();
  const open = await upToGithub(ana);

  const res = await h.postWebhook(srv.base, {
    event: 'app_deauthorized',
    payload: {
      account_id: 'acct-1', user_id: ana.zoomUserId, signature: 'uninstall-1', deauthorization_time: new Date().toISOString(), client_id: 'test-client-id',
    },
  });
  assert.equal(res.status, 200);

  assert.equal(store.status(ana.user.id).connected, false);
  assert.equal(await store.getAccessToken(ana.user.id), null);
  assert.equal(store.status(ben.user.id).connected, true);
  assert.equal((await callback({ code: secret(made('code')), state: open.state }, open.ghCookie)).status, 400);
  assert.equal(store.status(ana.user.id).connected, false);
  deauthorized._resetForTests();
});

test('GitHub not set up on the server: nothing is offered and no page starts a flow', async () => {
  const ana = person('Ana Ruiz');
  const real = githubAuth.getGithubAuth();
  const ticket = await ticketFor(ana);
  const { ghCookie } = await openStart(ticket);
  githubAuth._setForTests(githubAuth.createGithubAuth({ clientId: null, clientSecret: null, publicUrl: ORIGIN, fetch: fakeFetch }));
  try {
    assert.deepEqual((await connectors(ana)).body, { github: { available: false, connected: false, login: null } });
    const asked = await askTicket(ana);
    assert.equal(asked.status, 409);
    assert.equal(asked.body.error, 'not_available');
    assert.equal((await openStart(ticket)).status, 400);
    assert.equal((await click(ticket, ghCookie)).status, 400);
    const back = await callback({ code: made('code'), state: crypto.randomBytes(32).toString('base64url') }, ghCookie);
    assert.equal(back.status, 400);
    assert.ok(back.html.includes(NOT_CONNECTED));
    assert.equal(github.calls.length, 0);
  } finally {
    githubAuth._setForTests(real);
  }
});

test('the routes are rate limited: one client is stopped after 120 requests in the window', async () => {
  let last;
  for (let i = 0; i < 121; i += 1) last = await fetch(api('/github/start?ticket=x'));
  assert.equal(last.status, 429);
  // Another client is not affected
  client += 1;
  assert.equal((await fetch(api('/github/start?ticket=x'))).status, 400);
});

test('the access log has the path of /start and /callback and never their query string', async () => {
  const express = require('express');
  const morgan = require('morgan');
  const { accessLog, pathOnly } = require('../src/lib/accessLog');
  const [ticket, code, state] = [crypto.randomBytes(32).toString('base64url'), made('code'), crypto.randomBytes(32).toString('base64url')];

  assert.equal(pathOnly({ originalUrl: `/api/connectors/github/start?ticket=${ticket}` }), '/api/connectors/github/start');
  assert.equal(pathOnly({ originalUrl: `/api/connectors/github/callback?code=${code}&state=${state}` }), '/api/connectors/github/callback');

  for (const debug of [false, true]) {
    const lines = [];
    const stream = new PassThrough();
    stream.on('data', (chunk) => lines.push(String(chunk)));
    const app = express();
    app.use(accessLog(morgan, { debug, stream }));
    app.use((req, res) => res.send('ok'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => { server.once('listening', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/connectors/github/start?ticket=${ticket}`);
    await fetch(`${base}/api/connectors/github/callback?code=${code}&state=${state}`);
    // The page before travels in the Referer header: its query string is not logged either
    await fetch(`${base}/api/connectors/github/start`, { method: 'POST', headers: { referer: `${ORIGIN}/api/connectors/github/start?ticket=${ticket}` } });
    await h.wait(50);
    server.closeAllConnections?.();
    server.close();

    const output = lines.join('');
    assert.equal(lines.length, 3);
    assert.match(output, /GET \/api\/connectors\/github\/start /);
    assert.match(output, /GET \/api\/connectors\/github\/callback /);
    for (const hidden of [ticket, code, state, 'ticket=', 'code=', 'state=', '?']) {
      assert.equal(output.includes(hidden), false, `the access log has "${hidden}"`);
    }
  }
});

// Last: everything above has run
test('no log line holds a ticket, code, state, cookie value, token, the client secret, a user id or a GitHub login', () => {
  assert.ok(secrets.size > 100);
  assert.ok(logged.some((line) => line.startsWith('GitHub connect failed (')));
  for (const line of logged) {
    for (const hidden of secrets) {
      assert.equal(line.includes(hidden), false, 'a log line holds a value it must not');
    }
  }
  // What a failure logs is one of the fixed codes
  for (const code of failedCodes()) assert.match(code, /^[a-z_]{1,40}$/);
});
