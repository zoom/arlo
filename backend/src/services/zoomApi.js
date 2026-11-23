/**
 * Calls to Zoom's REST API on behalf of a signed-in user.
 *
 * Tokens live encrypted in memory (lib/memoryStore). An access token that has
 * expired, or that was dropped when a session was restored after a restart,
 * is refreshed first; Zoom rotates the refresh token on every use, so both are
 * stored again. Neither a token nor a response body is ever logged.
 */
const config = require('../config');
const { tokenStore } = require('../lib/memoryStore');
const { encryptToken, decryptToken } = require('./auth');

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

class ZoomApiError extends Error {
  constructor(message, { status = null, code = 'zoom_api_error' } = {}) {
    super(message);
    this.name = 'ZoomApiError';
    this.status = status;
    this.code = code;
  }
}

// One refresh at a time per user: a second refresh with the same (already
// rotated) refresh token would fail and sign the user out.
const refreshing = new Map(); // userId -> Promise<string>

async function refreshAccessToken(userId, stored) {
  if (!stored.refreshToken) {
    throw new ZoomApiError('No refresh token for this user', { code: 'no_token' });
  }
  const basic = Buffer.from(`${config.zoomClientId}:${config.zoomClientSecret}`).toString('base64');
  const response = await fetch(`${config.zoomOAuthUrl}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: decryptToken(stored.refreshToken),
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ZoomApiError(`Token refresh failed (${response.status})`, { status: response.status, code: 'refresh_failed' });
  }
  const data = await response.json();
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
    throw new ZoomApiError('Token refresh returned no tokens', { code: 'refresh_failed' });
  }
  const expiresIn = Number.isFinite(data.expires_in) ? data.expires_in : 3600;
  tokenStore.update(userId, {
    accessToken: encryptToken(data.access_token),
    refreshToken: encryptToken(data.refresh_token),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: typeof data.scope === 'string' ? data.scope.split(' ') : stored.scopes,
  });
  return data.access_token;
}

/** A usable access token for the user, refreshed if needed. */
async function getAccessToken(userId) {
  const stored = tokenStore.get(userId);
  if (!stored) {
    throw new ZoomApiError('No Zoom tokens for this user', { code: 'no_token' });
  }
  const fresh = stored.accessToken
    && new Date(stored.expiresAt).getTime() - Date.now() > REFRESH_MARGIN_MS;
  if (fresh) return decryptToken(stored.accessToken);

  if (!refreshing.has(userId)) {
    refreshing.set(userId, refreshAccessToken(userId, stored).finally(() => refreshing.delete(userId)));
  }
  return refreshing.get(userId);
}

/** POST JSON to Zoom's REST API as the user. Returns the parsed response body. */
async function zoomPost(userId, path, body = {}) {
  const accessToken = await getAccessToken(userId);
  const response = await fetch(`${config.zoomApiUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ZoomApiError(`Zoom API ${path} answered ${response.status}`, { status: response.status });
  }
  return response.json();
}

module.exports = { getAccessToken, zoomPost, ZoomApiError };
