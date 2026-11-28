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
 *   POST   /github/undo      the "Not right? Disconnect" button on the connected page
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
 *   approval sheet. The connected page names both accounts and has a
 *   button that undoes the connect, for ten minutes, from that browser only.
 * - A ticket, code, state, token and the client secret are secrets, and a
 *   GitHub login is personal data: none is logged, none is in an error
 *   message. A log line here says that something happened and, on failure, a
 *   code from a fixed list. The access log prints no query string
 *   (lib/accessLog.js).
 * - The pages are fixed strings. The variable parts are untrusted: a Zoom
 *   display name is cleaned, cut and HTML-escaped; a GitHub login is shown
 *   (on the connected page only) when it has the form of one. No script, and a
 *   Content-Security-Policy that allows none.
 * - Request bodies are exactly the known fields. Nothing is cached.
 * - The pages' forms are accepted only from this origin: `Origin` must be
 *   PUBLIC_URL's (never "null"), and `Sec-Fetch-Site`, when the browser sends
 *   it, must be "same-origin". A page with a form therefore has
 *   `Referrer-Policy: same-origin`: with "no-referrer" browsers send
 *   `Origin: null` on its POST.
 * - Rate limits (middleware/authLimiter.js): the steps of the flow share the
 *   auth limiter; reading and ending a connection have a limiter of their
 *   own, so the panel's polling cannot use up what signing in needs.
 * - A token GitHub issued that is not kept after all is revoked there.
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { authLimiter, connectorsLimiter } = require('../middleware/authLimiter');
const { userStore } = require('../lib/memoryStore');
const { cleanName } = require('../lib/displayName');
const {
  getGithubAuth, START_PATH, RANDOM_VALUE, CODE, STATE_TTL_MS, UNDO_TTL_MS,
} = require('../services/connectors/githubAuth');
const { getGithubConnections, disconnectGithubUser, tellPanels } = require('../services/connectors/githubConnections');

const router = express.Router();

const COOKIE = 'ghConnect';
// Sent only to this flow's routes, never to JavaScript, and on GitHub's
// redirect back (a top-level navigation: Lax lets it through)
const COOKIE_OPTIONS = Object.freeze({
  httpOnly: true, secure: true, sameSite: 'lax', path: '/api/connectors/github',
});
// Set when an account was connected: only the browser that finished the flow
// can undo it. Strict: sent with the connected page's own form and nothing else
const UNDO_COOKIE = 'ghUndo';
const UNDO_PATH = '/api/connectors/github/undo';
const UNDO_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true, secure: true, sameSite: 'strict', path: '/api/connectors/github',
});
const MAX_NAME_CHARS = 60;
// A GitHub login as github.com writes one: 1 to 39 letters, digits and inner
// hyphens. What is shown on a page is this or nothing
const SHOWN_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

const PAGE_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});
// A page with a form that posts back here. With "no-referrer" a browser sends
// `Origin: null` on that POST, which the POST routes refuse; "same-origin"
// sends the origin to this server and still nothing to any other
const FORM_PAGE_REFERRER = 'same-origin';
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
const DISCONNECTED_PAGE = page('Arlo', '<h1>Disconnected.</h1>');
const NOT_UNDONE_PAGE = page('Arlo', '<h1>That did not work. Disconnect GitHub from Arlo\'s settings.</h1>');

/**
 * The page after a connect: both accounts by name, so a person who connected
 * their GitHub to someone else's Arlo can see it, and a button that undoes
 * it. `login` is GitHub's and `name` a Zoom display name: both untrusted.
 */
function connectedPage(login, name) {
  const account = isShaped(login, SHOWN_LOGIN) ? `GitHub account <strong>${escapeHtml(login)}</strong>` : 'A GitHub account';
  const shown = cleanName(name, MAX_NAME_CHARS);
  const whose = shown.length > 0 ? ` for <strong>${escapeHtml(shown)}</strong>` : '';
  return page('Arlo', `<h1>${account} is now connected to Arlo${whose}.</h1>`
    + '<p>You can close this tab and go back to Zoom.</p>'
    + `<form method="post" action="${UNDO_PATH}">`
    + '<button type="submit">Not right? Disconnect</button></form>');
}

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

function sendPage(res, status, html, csp = PAGE_CSP, referrerPolicy = PAGE_HEADERS['Referrer-Policy']) {
  res.status(status).set(PAGE_HEADERS).set('Referrer-Policy', referrerPolicy).set('Content-Security-Policy', csp).send(html);
}

/**
 * True when a form POST comes from a page of this server: `Origin` is
 * PUBLIC_URL's origin (a missing one and "null" are not), and the browser's
 * own word on it, when there is one, is "same-origin".
 */
function fromThisOrigin(req) {
  if (req.get('origin') !== new URL(config.publicUrl).origin) return false;
  const site = req.get('sec-fetch-site');
  return site === undefined || site === 'same-origin';
}

/**
 * An async handler whose failure never becomes an unhandled rejection
 * (Express 4 does not look at a handler's promise). Nothing of the error is
 * logged: it could quote a request.
 */
const guarded = (handler, onError) => (req, res, next) => {
  Promise.resolve().then(() => handler(req, res, next)).catch(() => {
    if (res.headersSent) return;
    try {
      onError(req, res);
    } catch {
      // The connection is gone: nothing left to answer
    }
  });
};
const jsonError = (req, res) => res.status(500).json({ error: 'Internal Server Error' });

/**
 * End this user's connection the way "Disconnect" does: gone from memory at
 * once, the grant revoked at GitHub (waited for, best effort), their open
 * panels told. True when there was a connection.
 */
async function disconnect(userId) {
  // Gone from memory at once; GitHub is asked next, and its failure is logged as a code
  const { wasConnected, revoked } = disconnectGithubUser(userId);
  await revoked;
  if (wasConnected) {
    console.log('GitHub disconnected');
    // Their other open panels show it without a reload. Never throws
    tellPanels(userId);
  }
  return wasConnected;
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
router.get('/', connectorsLimiter, requireAuth, (req, res) => {
  res.json({ github: githubFor(req.user.id) });
});

/**
 * POST /api/connectors/github/ticket
 * A link for the signed-in caller that starts the flow in their browser.
 */
router.post('/github/ticket', authLimiter, requireAuth, requireJson, (req, res) => {
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
router.get('/github/start', authLimiter, (req, res) => {
  const auth = getGithubAuth();
  const { ticket } = req.query;
  const found = auth.available && isShaped(ticket, RANDOM_VALUE) ? auth.peekTicket(ticket) : null;
  const user = found ? userStore.findById(found.userId) : null;
  if (!user) return sendPage(res, 400, EXPIRED_PAGE);
  res.cookie(COOKIE, crypto.randomBytes(32).toString('base64url'), { ...COOKIE_OPTIONS, maxAge: STATE_TTL_MS });
  return sendPage(res, 200, startPage(user.displayName, ticket), START_PAGE_CSP, FORM_PAGE_REFERRER);
});

/**
 * POST /api/connectors/github/start
 * The click on the start page. Only from that page in that browser: the
 * cookie it set must be there and the form must come from this origin.
 */
router.post('/github/start', authLimiter, (req, res) => {
  const auth = getGithubAuth();
  const cookieValue = req.cookies ? req.cookies[COOKIE] : undefined;
  const sameOrigin = fromThisOrigin(req);
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
router.get('/github/callback', authLimiter, guarded(async (req, res) => {
  const auth = getGithubAuth();
  let flow = null;
  // The token GitHub issued in this request, until it is kept
  let issued = null;
  const failed = (code) => {
    if (flow) flow.end();
    // Issued and not kept: revoked at GitHub, best effort and not waited for
    if (issued) auth.discardToken(issued);
    issued = null;
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
    issued = exchanged.tokens.accessToken;
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
    issued = null;

    res.clearCookie(COOKIE, COOKIE_OPTIONS);
    // This browser, and no other, may undo the connect for ten minutes
    const undo = auth.createUndo(userId);
    if (undo) res.cookie(UNDO_COOKIE, undo, { ...UNDO_COOKIE_OPTIONS, maxAge: UNDO_TTL_MS });
    // Their open panels read the connectors again. Never throws: a panel
    // that cannot be told does not make a connect a failure
    tellPanels(userId);
    // That it happened, never who or as whom
    console.log('GitHub connected');
    const user = userStore.findById(userId);
    return sendPage(res, 200, connectedPage(who.login, user ? user.displayName : ''), PAGE_CSP, FORM_PAGE_REFERRER);
  } catch {
    // Nothing of the error is logged: it could quote a request
    return failed('error');
  }
}, (req, res) => sendPage(res, 400, NOT_CONNECTED_PAGE)));

/**
 * POST /api/connectors/github/undo
 * "Not right? Disconnect" on the connected page: ends the connection that
 * was just made. Only from that page in that browser, within ten minutes,
 * once: the cookie the callback set says whose connect it was. No session
 * (the system browser has none) and no field: the cookie is everything.
 */
router.post('/github/undo', authLimiter, guarded(async (req, res) => {
  const auth = getGithubAuth();
  const cookieValue = req.cookies ? req.cookies[UNDO_COOKIE] : undefined;
  const sameOrigin = fromThisOrigin(req);
  const noFields = req.body === undefined || hasExactly(req.body, []);
  if (!auth.available || !sameOrigin || !isShaped(cookieValue, RANDOM_VALUE) || !noFields) {
    // Such a request does not use the undo up
    return sendPage(res, sameOrigin ? 400 : 403, NOT_UNDONE_PAGE);
  }
  res.clearCookie(UNDO_COOKIE, UNDO_COOKIE_OPTIONS);
  // Used up by asking; null when unknown, used, expired, or the connection it
  // was for has ended since (disconnect and logout drop it)
  const found = auth.consumeUndo(cookieValue);
  if (!found) return sendPage(res, 400, NOT_UNDONE_PAGE);
  await disconnect(found.userId);
  return sendPage(res, 200, DISCONNECTED_PAGE);
}, (req, res) => sendPage(res, 400, NOT_UNDONE_PAGE)));

/**
 * DELETE /api/connectors/github
 * Forget the caller's connection. GitHub is asked to delete the grant as
 * well; when that fails the connection is gone here all the same. The
 * caller's open panels are told (`connectors.updated`).
 */
router.delete('/github', connectorsLimiter, requireAuth, guarded(async (req, res) => {
  await disconnect(req.user.id);
  return res.json({ connected: false });
}, jsonError));

module.exports = router;
