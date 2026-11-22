const crypto = require('crypto');
const config = require('../config');
const deauthorized = require('../lib/deauthorized');

/**
 * Generate PKCE code verifier and challenge
 *
 * NOTE: For Zoom in-client OAuth (Zoom Apps), the SDK defaults to "plain" PKCE method,
 * not S256. This means code_verifier === code_challenge.
 * See: https://devforum.zoom.us/t/pkce-does-not-work-but-is-obligatory-while-using-sdk-v0-16-x/76414
 */
function generatePKCE() {
  // Generate random code verifier (43-128 characters)
  const codeVerifier = base64URLEncode(crypto.randomBytes(32));

  // For Zoom in-client OAuth, use "plain" method: code_challenge = code_verifier
  // The S256 method doesn't work with the Zoom SDK's authorize() for in-client apps
  const codeChallenge = codeVerifier;

  return { codeVerifier, codeChallenge };
}

/**
 * Base64 URL encode (RFC 7636)
 */
function base64URLEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate random state parameter
 */
function generateState() {
  return base64URLEncode(crypto.randomBytes(32));
}

const TOKEN_CIPHER = 'aes-256-gcm';

/**
 * Encrypt a token with AES-256-GCM (authenticated encryption).
 * Format: iv:authTag:ciphertext, all hex. A fresh 12-byte nonce every time.
 */
function encryptToken(token) {
  const key = Buffer.from(config.encryptionKey, 'hex');
  const iv = crypto.randomBytes(12); // GCM recommended IV size is 12 bytes

  const cipher = crypto.createCipheriv(TOKEN_CIPHER, key, iv);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag(); // 16 bytes

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a token produced by encryptToken. Throws if it was modified, was
 * made with another key, or is not in the iv:authTag:ciphertext format. The
 * older unauthenticated CBC format (iv:ciphertext) is not accepted.
 */
function decryptToken(encryptedToken) {
  const parts = typeof encryptedToken === 'string' ? encryptedToken.split(':') : [];
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }
  const [ivHex, authTagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error('Invalid encrypted token format');
  }

  const key = Buffer.from(config.encryptionKey, 'hex');
  const decipher = crypto.createDecipheriv(TOKEN_CIPHER, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Generate simple JWT for WebSocket authentication
 * Note: For production, use a proper JWT library
 */
function generateToken(payload) {
  const header = base64URLEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64URLEncode(Buffer.from(JSON.stringify(payload)));
  const signature = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${header}.${body}.${signature}`;
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    const [header, body, signature] = token.split('.');

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', config.sessionSecret)
      .update(`${header}.${body}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      throw new Error('Invalid signature');
    }

    // Decode payload
    const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));

    // Check expiration
    if (payload.exp && Date.now() > payload.exp) {
      throw new Error('Token expired');
    }

    return payload;
  } catch (error) {
    throw new Error('Invalid token');
  }
}

/**
 * Verify a *session* token. Rejects other token kinds signed with the same key
 * (e.g. meeting-access tokens) so they can't be replayed as a login session.
 */
function verifySessionToken(token) {
  const payload = verifyToken(token);
  if (payload.kind || !payload.userId) {
    throw new Error('Invalid token');
  }
  // The user removed the app: their session ends now, not when the token expires
  if (payload.zoomUserId && deauthorized.isDeauthorized(payload.zoomUserId)) {
    throw new Error('Invalid token');
  }
  return payload;
}

module.exports = {
  verifySessionToken,
  generatePKCE,
  generateState,
  encryptToken,
  decryptToken,
  generateToken,
  verifyToken,
  base64URLEncode,
};
