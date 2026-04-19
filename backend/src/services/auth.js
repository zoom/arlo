const crypto = require('crypto');
const config = require('../config');

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

/**
 * Encrypt access token for storage using AES-256-GCM (authenticated encryption)
 * Format: iv:authTag:ciphertext (all hex-encoded)
 */
function encryptToken(token) {
  const algorithm = 'aes-256-gcm';
  const key = Buffer.from(config.encryptionKey, 'hex');
  const iv = crypto.randomBytes(12); // GCM recommended IV size is 12 bytes

  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Get the authentication tag (16 bytes)
  const authTag = cipher.getAuthTag();

  // Return iv:authTag:ciphertext (all hex-encoded)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt access token from storage using AES-256-GCM (authenticated encryption)
 * Supports both new format (iv:authTag:ciphertext) and legacy format (iv:ciphertext)
 */
function decryptToken(encryptedToken) {
  const key = Buffer.from(config.encryptionKey, 'hex');
  const parts = encryptedToken.split(':');

  // Check if this is the new GCM format (3 parts) or legacy CBC format (2 parts)
  if (parts.length === 3) {
    // New AES-256-GCM format: iv:authTag:ciphertext
    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } else if (parts.length === 2) {
    // Legacy AES-128-CBC format: iv:ciphertext (for backwards compatibility during migration)
    // This path will fail if the key is now 32 bytes instead of 16 bytes
    console.warn('⚠️ Decrypting token in legacy CBC format — re-encryption recommended');
    const [ivHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, 'hex');

    // Use only first 16 bytes of key for legacy CBC (if key is 32 bytes)
    const legacyKey = key.length > 16 ? key.slice(0, 16) : key;
    const decipher = crypto.createDecipheriv('aes-128-cbc', legacyKey, iv);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } else {
    throw new Error('Invalid encrypted token format');
  }
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

module.exports = {
  generatePKCE,
  generateState,
  encryptToken,
  decryptToken,
  generateToken,
  verifyToken,
  base64URLEncode,
};
