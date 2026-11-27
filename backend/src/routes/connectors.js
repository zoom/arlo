/**
 * What a signed-in user has connected to Arlo, mounted at /api/connectors.
 * GitHub is the first: a user connects their own GitHub account once.
 *
 *   GET    /                 { github: { available, connected, login } }, for the caller only
 *   POST   /github/ticket    {}: a one-time link that starts the flow in the system browser
 *   GET    /github/start     ?ticket=: the page that says whose Arlo is being connected
 *   POST   /github/start     form `ticket`: the click on that page; redirects to GitHub
 *   GET    /github/callback  ?code=&state=: GitHub's redirect back; keeps the tokens
 *   DELETE /github           forget the caller's connection and revoke it at GitHub
 *
 * The panel runs inside Zoom and GitHub's pages open in the system browser,
 * which has no Arlo session. The three browser routes therefore take no
 * session: a ticket issued to the signed-in panel says which Arlo user the
 * flow is for, and a cookie set on the start page ties the rest of the flow to
 * that browser (services/connectors/githubAuth.js).
 *
 * SECURITY
 * - Known limit (account mix-up): someone signed in to Arlo can send their
 *   start link to another person; if that person clicks through and approves
 *   on GitHub, their GitHub account is connected to the sender's Arlo. A
 *   ticket in a link cannot prevent it. What limits it: the start page names
 *   whose Arlo is being connected and needs a click, the ticket lives five
 *   minutes and works once, the GitHub App asks for Issues only, the
 *   repository is the deployment's, and creating anything still needs the
 *   approval sheet.
 * - A ticket, code, state, token and the client secret are secrets, and a
 *   GitHub login is personal data: none is logged, none is in an error
 *   message. A log line here says that something happened and, on failure, a
 *   code from a fixed list. The access log prints no query string
 *   (lib/accessLog.js).
 * - The two pages are fixed strings. The one variable part, a Zoom display
 *   name, is untrusted: cleaned, cut and HTML-escaped. No script, and a
 *   Content-Security-Policy that allows none.
 * - Request bodies are exactly the known fields. Nothing is cached.
 * - Rate limited with the auth limiter (server.js).
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { userStore } = require('../lib/memoryStore');
const { cleanName } = require('../lib/displayName');
const {
  getGithubAuth, START_PATH, RANDOM_VALUE, CODE, STATE_TTL_MS,
} = require('../services/connectors/githubAuth');
const { getGithubConnections } = require('../services/connectors/githubConnections');

const router = express.Router();

const COOKIE = 'ghConnect';
// Sent only to this flow's routes, never to JavaScript, and on GitHub's
// redirect back (a top-level navigation: Lax lets it through)
const COOKIE_OPTIONS = Object.freeze({
  httpOnly: true, secure: true, sameSite: 'lax', path: '/api/connectors/github',
});
const MAX_NAME_CHARS = 60;

const PAGE_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";
// The start page's form posts to this server, which answers with a redirect
// to GitHub. Browsers that apply form-action to that redirect (Chrome,
// Safari) would stop it there, so GitHub is named for this one page
const START_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'";

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** An object whose keys are exactly `keys`. */
const hasExactly = (body, keys) => isPlainObject(body)
  && Object.keys(body).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(body, key));
const isShaped = (value, shape) => typeof value === 'string' && shape.test(value);

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
});
/** Text as it can stand in HTML, in an element or a quoted attribute. */
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

const PAGE_STYLE = 'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
  + 'background:#f6f5f2;color:#1c1b19}main{max-width:28rem;margin:18vh auto 0;padding:0 1.5rem}'
  + 'h1{font-size:1.25rem;font-weight:600;line-height:1.4}p{color:#5c5a55;line-height:1.5}'
  + 'button{font:inherit;font-weight:600;padding:.6rem 1.1rem;border:0;border-radius:.5rem;'
  + 'background:#1c1b19;color:#fff;cursor:pointer}';

const page = (title, body) => '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + `<title>${title}</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>\n`;

const EXPIRED_PAGE = page('Arlo', '<h1>This link has expired. Start again from Arlo\'s settings.</h1>');
const NOT_CONNECTED_PAGE = page('Arlo', '<h1>GitHub was not connected. Start again from Arlo\'s settings.</h1>');
const CONNECTED_PAGE = page('Arlo', '<h1>GitHub is connected. You can close this tab and go back to Zoom.</h1>');

/** The start page for one ticket. `name` is a Zoom display name: untrusted. */
function startPage(name, ticket) {
  const shown = cleanName(name, MAX_NAME_CHARS);
  const whose = shown.length > 0
    ? `<strong>${escapeHtml(shown)}</strong>`
    : 'the person who opened this page from Arlo';
  return page('Connect GitHub to Arlo', `<h1>Connect a GitHub account to Arlo for ${whose}</h1>`
    + `<form method="post" action="${START_PATH}">`
    + `<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">`
    + '<button type="submit">Continue to GitHub</button></form>'
    + '<p>Not you? Close this tab.</p>');
}

function sendPage(res, status, html, csp = PAGE_CSP) {
  res.status(status).set(PAGE_HEADERS).set('Content-Security-Policy', csp).send(html);
}

/** What is known about the caller's GitHub connection. Never a token. */
function githubFor(userId) {
  const available = getGithubAuth().available;
  const { connected, login } = getGithubConnections().status(userId);
  return { available, connected, login: connected ? login : null };
}

// What a user has connected must not stay in a browser or proxy cache. First,
// so refusals are not cached either.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/** Bodies are JSON only: a form post (which a page on another site can send) is refused. */
function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Unsupported Media Type', message: 'Send JSON' });
  }
  return next();
}

/**
 * GET /api/connectors
 * What the caller has connected. The login is the caller's own.
 */
router.get('/', requireAuth, (req, res) => {
  res.json({ github: githubFor(req.user.id) });
});

/**
 * POST /api/connectors/github/ticket
 * A link for the signed-in caller that starts the flow in their browser.
 */
router.post('/github/ticket', requireAuth, requireJson, (req, res) => {
  if (!hasExactly(req.body, [])) {
    return res.status(400).json({ error: 'Invalid request', message: 'Send an empty JSON object' });
  }
  const auth = getGithubAuth();
  if (!auth.available) {
    return res.status(409).json({ error: 'not_available', message: 'GitHub is not set up on this server.' });
  }
  const ticket = auth.issueTicket(req.user.id);
  if (!ticket) return res.status(400).json({ error: 'Invalid request' });
  return res.json({ url: `${config.publicUrl.replace(/\/+$/, '')}${START_PATH}?ticket=${ticket}` });
});

/**
 * GET /api/connectors/github/start?ticket=
 * The page in the system browser: whose Arlo is being connected, and one
 * button. The ticket is looked at, not used: a link preview or a reload must
 * not spend it.
 */
router.get('/github/start', (req, res) => {
  const auth = getGithubAuth();
  const { ticket } = req.query;
  const found = auth.available && isShaped(ticket, RANDOM_VALUE) ? auth.peekTicket(ticket) : null;
  const user = found ? userStore.findById(found.userId) : null;
  if (!user) return sendPage(res, 400, EXPIRED_PAGE);
  res.cookie(COOKIE, crypto.randomBytes(32).toString('base64url'), { ...COOKIE_OPTIONS, maxAge: STATE_TTL_MS });
  return sendPage(res, 200, startPage(user.displayName, ticket), START_PAGE_CSP);
});

/**
 * POST /api/connectors/github/start
 * The click on the start page. Only from that page in that browser: the
 * cookie it set must be there and the form must come from this origin.
 */
router.post('/github/start', (req, res) => {
  const auth = getGithubAuth();
  const cookieValue = req.cookies ? req.cookies[COOKIE] : undefined;
  const sameOrigin = req.get('origin') === new URL(config.publicUrl).origin;
  if (!auth.available || !sameOrigin || !isShaped(cookieValue, RANDOM_VALUE)
    || !req.is('application/x-www-form-urlencoded') || !hasExactly(req.body, ['ticket'])
    || !isShaped(req.body.ticket, RANDOM_VALUE)) {
    // The ticket is not used up by a request that could not have been the page's
    return sendPage(res, sameOrigin ? 400 : 403, EXPIRED_PAGE);
  }
  const found = auth.consumeTicket(req.body.ticket);
  const user = found ? userStore.findById(found.userId) : null;
  const next = user ? auth.createState({ userId: user.id, cookieValue }) : null;
  if (!next) return sendPage(res, 400, EXPIRED_PAGE);
  // No body: the URL (it holds the state) is in the Location header only
  return res.status(303).set('Referrer-Policy', 'no-referrer').set('Location', next.url).end();
});

/**
 * GET /api/connectors/github/callback?code=&state=
 * GitHub's redirect back, in the browser that started the flow. Every failure
 * is the same page: it says nothing about why.
 */
router.get('/github/callback', async (req, res) => {
  const auth = getGithubAuth();
  let flow = null;
  const failed = (code) => {
    if (flow) flow.end();
    // A code from this file's and githubAuth's fixed lists, never a value
    console.warn(`GitHub connect failed (${code})`);
    res.clearCookie(COOKIE, COOKIE_OPTIONS);
    return sendPage(res, 400, NOT_CONNECTED_PAGE);
  };
  try {
    if (!auth.available) return failed('not_available');
    const { code, state, error } = req.query;
    // The state is used up whatever else the request says: it works once
    flow = isShaped(state, RANDOM_VALUE) ? auth.consumeState(state, req.cookies ? req.cookies[COOKIE] : undefined) : null;
    if (error !== undefined) return failed('denied');
    if (!isShaped(state, RANDOM_VALUE) || !isShaped(code, CODE)) return failed('bad_request');
    if (!flow) return failed('bad_state');
    const { userId } = flow;
    if (!userStore.findById(userId)) return failed('user_gone');

    const exchanged = await auth.exchangeCode({ code, codeVerifier: flow.codeVerifier });
    if (!exchanged.ok) return failed(exchanged.code);
    const who = await auth.fetchUser(exchanged.tokens.accessToken);
    if (!who.ok) return failed(who.code);

    // Signed out or removed the app while GitHub was asked: nothing is kept
    if (!flow.end() || !userStore.findById(userId)) {
      flow = null;
      return failed('user_gone');
    }
    flow = null;
    const kept = getGithubConnections().set(userId, {
      ...exchanged.tokens, login: who.login, githubUserId: who.githubUserId,
    });
    if (!kept) return failed('bad_response');

    res.clearCookie(COOKIE, COOKIE_OPTIONS);
    // Required here: the socket server's neighbours require this module's neighbours
    // eslint-disable-next-line global-require
    require('../services/websocket').sendConnectorsUpdated(userId);
    // That it happened, never who or as whom
    console.log('GitHub connected');
    return sendPage(res, 200, CONNECTED_PAGE);
  } catch {
    // Nothing of the error is logged: it could quote a request
    return failed('error');
  }
});

/**
 * DELETE /api/connectors/github
 * Forget the caller's connection. GitHub is asked to delete the grant as
 * well; when that fails the connection is gone here all the same.
 */
router.delete('/github', requireAuth, async (req, res) => {
  const connections = getGithubConnections();
  const userId = req.user.id;
  try {
    const wasConnected = connections.status(userId).connected;
    // Revoking needs a token that still works (an expired one is refreshed first)
    const accessToken = wasConnected ? await connections.getAccessToken(userId) : null;
    connections.remove(userId);
    if (accessToken) {
      const revoked = await getGithubAuth().revokeGrant(accessToken);
      if (!revoked.ok) console.warn(`GitHub disconnect: the grant was not revoked at GitHub (${revoked.code})`);
    } else if (wasConnected) {
      console.warn('GitHub disconnect: the grant was not revoked at GitHub (no_token)');
    }
    if (wasConnected) console.log('GitHub disconnected');
  } catch {
    connections.remove(userId);
    console.warn('GitHub disconnect: the grant was not revoked at GitHub (error)');
  }
  return res.json({ connected: false });
});

module.exports = router;
