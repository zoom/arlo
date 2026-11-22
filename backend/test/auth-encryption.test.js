// Token encryption: AES-256-GCM only, with a 32-byte key. The older 16-byte
// key (AES-128) and the unauthenticated CBC format are no longer accepted.
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encryptToken, decryptToken } = require('../src/services/auth');

test('tokens are encrypted with AES-256-GCM and read back', () => {
  const encrypted = encryptToken('zoom-refresh-token');
  const [iv, tag, ciphertext] = encrypted.split(':');
  assert.equal(encrypted.split(':').length, 3);
  assert.equal(iv.length, 24);   // 12-byte nonce
  assert.equal(tag.length, 32);  // 16-byte authentication tag
  assert.equal(ciphertext.includes('zoom-refresh-token'), false);
  assert.equal(decryptToken(encrypted), 'zoom-refresh-token');

  // The key in use is 32 bytes: decrypting by hand with AES-256-GCM works
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  assert.equal(decipher.update(ciphertext, 'hex', 'utf8') + decipher.final('utf8'), 'zoom-refresh-token');
});

test('every encryption uses a fresh nonce', () => {
  assert.notEqual(encryptToken('same'), encryptToken('same'));
});

test('a modified token is rejected, not decrypted to something else', () => {
  const encrypted = encryptToken('zoom-refresh-token');
  const [iv, tag, ciphertext] = encrypted.split(':');
  const flip = (hex) => hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');
  assert.throws(() => decryptToken(`${iv}:${tag}:${flip(ciphertext)}`));
  assert.throws(() => decryptToken(`${iv}:${flip(tag)}:${ciphertext}`));
  assert.throws(() => decryptToken(`${flip(iv)}:${tag}:${ciphertext}`));
});

test('the legacy unauthenticated CBC format is refused', () => {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex').subarray(0, 16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const legacy = `${iv.toString('hex')}:${cipher.update('old-token', 'utf8', 'hex') + cipher.final('hex')}`;
  assert.throws(() => decryptToken(legacy), /format/i);
  assert.throws(() => decryptToken('not-a-token'), /format/i);
});

// Start-up validation, checked in a child process because config exits on failure.
function startConfig(extraEnv) {
  const env = {
    PATH: process.env.PATH,
    ZOOM_CLIENT_ID: 'test-client-id',
    ZOOM_CLIENT_SECRET: 'test-client-secret-value',
    ZOOM_WEBHOOK_TOKEN: 'test-webhook-token-value',
    PUBLIC_URL: 'https://arlo.example.test',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    NODE_ENV: 'test',
    ...extraEnv,
  };
  return spawnSync(process.execPath, ['-e', "require('./src/config'); console.log('config ok')"], {
    cwd: path.join(__dirname, '..'), env, encoding: 'utf8',
  });
}
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

test('the server starts with a 32-byte key, as hex or base64', () => {
  assert.equal(startConfig({ TOKEN_ENCRYPTION_KEY: hex(32) }).status, 0);
  assert.equal(startConfig({ TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') }).status, 0);
});

test('the server refuses to start with a 16-byte (AES-128) key and says how to fix it', () => {
  const result = startConfig({ TOKEN_ENCRYPTION_KEY: hex(16) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TOKEN_ENCRYPTION_KEY/);
  assert.match(result.stderr, /64/);
  assert.match(result.stderr, /randomBytes\(32\)/);
});

test('the old REDIS_ENCRYPTION_KEY variable is no longer a substitute', () => {
  const result = startConfig({ REDIS_ENCRYPTION_KEY: hex(32) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TOKEN_ENCRYPTION_KEY/);
});

test('the key is never echoed in a start-up error', () => {
  const badKey = hex(16);
  const result = startConfig({ TOKEN_ENCRYPTION_KEY: badKey });
  assert.equal((result.stderr + result.stdout).includes(badKey), false);
});
