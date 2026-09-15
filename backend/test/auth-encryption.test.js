const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

process.env.ZOOM_CLIENT_ID = 'test-client-id';
process.env.ZOOM_CLIENT_SECRET = 'test-client-secret';
process.env.PUBLIC_URL = 'https://arlo.example.test';
process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.REDIS_ENCRYPTION_KEY = '00112233445566778899aabbccddeeff';
process.env.TOKEN_ENCRYPTION_KEY =
  'ffeeddccbbaa9988776655443322110000112233445566778899aabbccddeeff';

const { encryptToken, decryptToken } = require('../src/services/auth');

function encryptLegacy(token) {
  const key = Buffer.from(process.env.REDIS_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  let ciphertext = cipher.update(token, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  return `${iv.toString('hex')}:${ciphertext}`;
}

test('writes versioned AES-256-GCM tokens and reads them back', () => {
  const encrypted = encryptToken('access-token-value');

  assert.match(encrypted, /^v2:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
  assert.equal(decryptToken(encrypted), 'access-token-value');
});

test('decrypts legacy CBC tokens with the separate legacy key', () => {
  const encrypted = encryptLegacy('legacy-refresh-token');

  assert.equal(decryptToken(encrypted), 'legacy-refresh-token');
});

test('supports deriving a GCM key from a deployed 16-byte legacy secret', () => {
  const config = require('../src/config');
  const currentKey = config.encryptionKey;
  config.encryptionKey = process.env.REDIS_ENCRYPTION_KEY;

  try {
    const encrypted = encryptToken('derived-key-token');
    assert.equal(decryptToken(encrypted), 'derived-key-token');
  } finally {
    config.encryptionKey = currentKey;
  }
});

test('rejects modified GCM ciphertext', () => {
  const encrypted = encryptToken('sensitive-token');
  const parts = encrypted.split(':');
  const lastNibble = parts[3].at(-1);
  parts[3] = `${parts[3].slice(0, -1)}${lastNibble === '0' ? '1' : '0'}`;

  assert.throws(() => decryptToken(parts.join(':')));
});

test('rejects malformed encrypted values', () => {
  assert.throws(() => decryptToken('not-an-encrypted-token'));
  assert.throws(() => encryptToken(''));
});
