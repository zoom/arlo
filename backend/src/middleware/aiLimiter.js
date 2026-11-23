/**
 * The rate limit for everything that calls a model: 20 requests a minute per
 * client address. One instance, so /api/ai/* and Arlo's ask route count
 * against the same allowance.
 */
const rateLimit = require('express-rate-limit');

const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please try again later' },
});

module.exports = { aiLimiter };
