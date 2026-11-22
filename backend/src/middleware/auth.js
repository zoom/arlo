const { verifySessionToken } = require('../services/auth');
const config = require('../config');
const { restoreIfMissing } = require('../services/sessionRestore');
const { verifyMeetingAccessToken } = require('../services/zoomAppContext');

/**
 * Authentication middleware
 * Verifies JWT from httpOnly cookie and attaches user to req.user
 */
function requireAuth(req, res, next) {
  try {
    // Skip if req.user was already set (e.g., by devAuthBypass)
    if (req.user) {
      return next();
    }

    // Get token from httpOnly cookie
    const token = req.cookies?.sessionToken;

    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'No session token found',
      });
    }

    // Verify token
    const payload = verifySessionToken(token);

    // After a server restart the user is gone from memory; rebuild them from
    // their encrypted restore cookie if they sent one.
    restoreIfMissing(req, payload);

    // Attach user info to request
    req.user = {
      id: payload.userId,
      zoomUserId: payload.zoomUserId,
    };

    next();
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired session token',
    });
  }
}

/**
 * Optional authentication middleware
 * Attaches user if present, but doesn't require it
 * Useful for routes that work with or without auth
 */
function optionalAuth(req, res, next) {
  try {
    const token = req.cookies?.sessionToken;

    if (token) {
      const payload = verifySessionToken(token);
      restoreIfMissing(req, payload);
      req.user = {
        id: payload.userId,
        zoomUserId: payload.zoomUserId,
      };
    }
  } catch (error) {
    // Silently fail - token might be expired, let route decide what to do
    console.warn('Optional auth failed:', error.message);
  }

  next();
}

/**
 * Meeting-scoped routes (`/…/by-zoom-id/:zoomMeetingId/…`).
 * The caller must hold a verified meeting-access cookie for exactly that
 * meeting: the same proof that opens the WebSocket. It is issued by
 * POST /api/auth/meeting-access from the Zoom App Context, so it works for
 * guests, and being signed in does not replace it.
 */
function requireMeetingAccess(req, res, next) {
  const token = req.cookies?.meetingAccess;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Meeting access required' });
  }
  let access;
  try {
    access = verifyMeetingAccessToken(token);
  } catch {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired meeting access' });
  }
  if (access.meetingId !== req.params.zoomMeetingId) {
    return res.status(403).json({ error: 'Forbidden', message: 'Not a participant of this meeting' });
  }
  req.meetingAccess = access;
  return next();
}

/**
 * Development mode bypass
 * Allows query param userId in dev mode for testing
 */
function devAuthBypass(req, res, next) {
  // Explicit opt-in only, and never in production. docker-compose runs with
  // NODE_ENV=development behind a public ngrok URL, so NODE_ENV alone must not
  // enable impersonation via ?userId=.
  if (process.env.ALLOW_DEV_AUTH_BYPASS !== 'true' || config.nodeEnv === 'production') {
    return next();
  }

  // Check for userId in query params (dev mode only)
  const { userId } = req.query;
  if (userId && !req.user) {
    req.user = {
      id: userId,
      zoomUserId: `dev-user-${userId}`,
    };
    console.warn('⚠️  Dev mode: using the userId query parameter as the signed-in user');
  }

  next();
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireMeetingAccess,
  devAuthBypass,
};
