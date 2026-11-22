/**
 * Internal service-to-service authentication (rtms service <-> backend).
 *
 * The rtms service calls /api/rtms/broadcast, /status and /participant-event on
 * the backend, and the backend forwards verified webhooks to the rtms service.
 * Those calls carry `x-arlo-internal-key`. The key is INTERNAL_API_SECRET if set,
 * otherwise it is derived from ZOOM_WEBHOOK_TOKEN (which both services already
 * require), so existing deployments need no new configuration.
 *
 * The rtms service has a matching implementation in rtms/src/index.js — keep
 * the derivation in sync.
 */
const crypto = require('crypto');
require('../config'); // ensures .env is loaded and ZOOM_WEBHOOK_TOKEN validated

const HEADER = 'x-arlo-internal-key';

function deriveInternalKey() {
  if (process.env.INTERNAL_API_SECRET) {
    return process.env.INTERNAL_API_SECRET;
  }
  const webhookToken = process.env.ZOOM_WEBHOOK_TOKEN;
  if (!webhookToken) {
    throw new Error('ZOOM_WEBHOOK_TOKEN (or INTERNAL_API_SECRET) is required for internal auth');
  }
  return crypto.createHmac('sha256', webhookToken).update('arlo-internal-v1').digest('hex');
}

const INTERNAL_KEY = deriveInternalKey();

/** True if the request carries a valid internal key (timing-safe). */
function isInternalRequest(req) {
  const provided = req.headers[HEADER];
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(INTERNAL_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Express middleware: reject anything that isn't an internal call. */
function requireInternal(req, res, next) {
  if (isInternalRequest(req)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = {
  INTERNAL_KEY_HEADER: HEADER,
  getInternalKey: () => INTERNAL_KEY,
  isInternalRequest,
  requireInternal,
};
