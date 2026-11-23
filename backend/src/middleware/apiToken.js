/**
 * Routes a script may call: a browser session, or an API token with the
 * required scope.
 *
 * If an Authorization header is present it decides alone. A bad or
 * under-scoped token is refused even when a valid session cookie came along,
 * so a caller always knows which credential was judged.
 */
const rateLimit = require('express-rate-limit');
const apiTokens = require('../lib/apiTokens');
const { userStore } = require('../lib/memoryStore');
const deauthorized = require('../lib/deauthorized');
const { requireAuth } = require('./auth');

// Per token, separate from the per-address limits: a looping script cannot
// use up the budget of the person's own panel.
const tokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `api-token:${req.apiToken.id}`,
  message: { error: 'Too many requests', message: 'This API token is limited to 60 requests a minute.' },
});

function bearerFrom(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined; // no header: fall back to the session
  const match = /^Bearer\s+(\S*)$/i.exec(header.trim());
  return match ? match[1] : '';
}

function sessionOrToken(scope) {
  return (req, res, next) => {
    const bearer = bearerFrom(req);
    if (bearer === undefined) return requireAuth(req, res, next);

    const record = apiTokens.authenticate(bearer);
    const user = record ? userStore.findById(record.userId) : null;
    if (!record || !user || deauthorized.isDeauthorized(record.zoomUserId)) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired API token' });
    }
    if (!record.scopes.includes(scope)) {
      return res.status(403).json({ error: 'Forbidden', message: `This API token lacks the ${scope} scope` });
    }
    req.user = { id: user.id, zoomUserId: user.zoomUserId };
    req.apiToken = { id: record.id, scopes: record.scopes };
    return tokenLimiter(req, res, next);
  };
}

module.exports = { sessionOrToken };
