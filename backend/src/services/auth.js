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

const TOKEN_ENCRYPTION_VERSION = 'v2';
const TOKEN_KEY_DERIVATION_CONTEXT = Buffer.from('arlo:oauth-token:v2\0', 'utf8');

function getEncryptionKeyBytes() {
  const key = Buffer.from(config.encryptionKey, 'hex');
  if (key.length !== 16 && key.length !== 32) {
    throw new Error('Token encryption key must be 16 or 32 bytes');
  }
  return key;
}

function getLegacyEncryptionKeyBytes() {
  const key = Buffer.from(config.legacyEncryptionKey || config.encryptionKey, 'hex');
  if (key.length !== 16 && key.length !== 32) {
    throw new Error('Legacy token encryption key must be 16 or 32 bytes');
  }
  return key;
}

function getGcmKey() {
  const key = getEncryptionKeyBytes();
  if (key.length === 32) return key;

  // Preserve existing deployments while producing a separate 32-byte GCM key.
  return crypto.createHash('sha256')
    .update(TOKEN_KEY_DERIVATION_CONTEXT)
    .update(key)
    .digest();
}

function decryptGcm(ivHex, authTagHex, ciphertextHex) {
  if (!/^[0-9a-f]{24}$/i.test(ivHex) ||
      !/^[0-9a-f]{32}$/i.test(authTagHex) ||
      !/^[0-9a-f]+$/i.test(ciphertextHex)) {
    throw new Error('Invalid encrypted token format');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getGcmKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Encrypt access tokens with authenticated encryption.
 * Format: v2:iv:authTag:ciphertext (all binary values are hexadecimal).
 */
function encryptToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Token must be a non-empty string');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getGcmKey(), iv);
  let ciphertext = cipher.update(token, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  return [
    TOKEN_ENCRYPTION_VERSION,
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    ciphertext,
  ].join(':');
}

/**
 * Decrypt current GCM tokens and legacy AES-128-CBC tokens.
 * Legacy values are upgraded naturally the next time Zoom refreshes OAuth.
 */
function decryptToken(encryptedToken) {
  if (typeof encryptedToken !== 'string') {
    throw new Error('Invalid encrypted token format');
  }

  const parts = encryptedToken.split(':');

  if (parts.length === 4 && parts[0] === TOKEN_ENCRYPTION_VERSION) {
    return decryptGcm(parts[1], parts[2], parts[3]);
  }

  // Compatibility with the unversioned GCM format briefly used upstream.
  if (parts.length === 3) {
    return decryptGcm(parts[0], parts[1], parts[2]);
  }

  if (parts.length === 2) {
    const [ivHex, ciphertextHex] = parts;
    if (!/^[0-9a-f]{32}$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(ciphertextHex)) {
      throw new Error('Invalid encrypted token format');
    }

    const legacyKey = getLegacyEncryptionKeyBytes().subarray(0, 16);
    const decipher = crypto.createDecipheriv(
      'aes-128-cbc',
      legacyKey,
      Buffer.from(ivHex, 'hex')
    );
    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  throw new Error('Invalid encrypted token format');
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
