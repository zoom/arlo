/**
 * The rate limits for signing in and for "Connect GitHub", per client address.
 *
 * authLimiter: 120 requests per 15 minutes. One instance, so /api/auth/* and
 * the steps of the GitHub connect flow (the ticket, the start page and its
 * click, GitHub's callback, the undo) count against the same allowance.
 *
 * connectorsLimiter: 300 requests per 15 minutes, for reading and ending a
 * connection (GET /api/connectors, DELETE /api/connectors/github). The panel
 * asks GET /api/connectors every 3 seconds while a connect waits for the
 * browser, for at most 5 minutes: 100 requests, plus a read when the panel
 * gets the focus back. A limit of its own, so that polling can never use up
 * what signing in needs.
 */
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120, // Raised from 30: OAuth + meeting bootstrap can burst during app open.
  skip: (req) => req.path === '/poll-code', // poll-code uses authPollLimiter instead.
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts' },
});

const connectorsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

module.exports = { authLimiter, connectorsLimiter };
