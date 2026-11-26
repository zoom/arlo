/**
 * Shared test helpers: boot the backend in-process with throwaway secrets on a
 * random port, and build Zoom-format app context tokens.
 *
 * Every secret here is a random value generated per test run. Never put real
 * credentials in tests.
 */
const crypto = require('node:crypto');
const { once } = require('node:events');

const rnd = () => crypto.randomBytes(32).toString('hex');

const TEST_CLIENT_SECRET = `test-client-secret-${rnd()}`;
const TEST_WEBHOOK_TOKEN = `test-webhook-token-${rnd()}`;

/**
 * The server prints a lot to stdout. Under `node --test` each test file is a
 * child process that reports results to the runner over that same stdout, and
 * application output mixed into it intermittently corrupted the report
 * ("Unable to deserialize cloned data"), failing a whole file at random.
 * Tests therefore run with stdout logging off; warnings and errors (stderr)
 * still show. Set ARLO_TEST_LOGS=1 to see everything when debugging a test.
 */
function quietStdout() {
  if (process.env.ARLO_TEST_LOGS === '1') return;
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
}

/** Set test env. Must run before anything requires src/config. */
function setTestEnv(extra = {}) {
  quietStdout();
  Object.assign(process.env, {
    ZOOM_CLIENT_ID: 'test-client-id',
    ZOOM_CLIENT_SECRET: TEST_CLIENT_SECRET,
    ZOOM_WEBHOOK_TOKEN: TEST_WEBHOOK_TOKEN,
    PUBLIC_URL: 'https://arlo.example.test',
    SESSION_SECRET: rnd(),
    TOKEN_ENCRYPTION_KEY: rnd(),
    FRONTEND_URL: 'http://127.0.0.1:9', // nothing listens; keeps the proxy health check local
    PORT: '0', // random free port
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    AI_ENABLED: 'true',
    DEMO_MODE: 'true',
    ...extra,
  });
  // The tool table depends on it: only a test that sets it has it
  if (!Object.prototype.hasOwnProperty.call(extra, 'GITHUB_DEFAULT_REPO')) delete process.env.GITHUB_DEFAULT_REPO;
  // A developer's shell often has a real GITHUB_TOKEN: a test never reads it
  for (const name of ['GITHUB_TOKEN', 'GITHUB_MCP_URL']) {
    if (!Object.prototype.hasOwnProperty.call(extra, name)) delete process.env[name];
  }
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.ALLOW_DEV_AUTH_BYPASS;
  delete process.env.ENABLE_DEBUG_ROUTES;
}

/** Boot the real server. Returns { base, wsBase, server }. */
async function startServer() {
  const { server } = require('../src/server');
  if (!server.listening) await once(server, 'listening');
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}/ws` };
}

/** Internal service key, derived the same way the rtms service does. */
function internalKey() {
  return crypto.createHmac('sha256', TEST_WEBHOOK_TOKEN).update('arlo-internal-v1').digest('hex');
}

/**
 * Build an app context token in Zoom's format:
 * base64url([ivLen:1][iv][aadLen:2 LE][aad][ctLen:4 LE][ciphertext][tag:16]),
 * AES-256-GCM with key = SHA-256(client secret).
 */
function makeAppContext(payload, { secret = TEST_CLIENT_SECRET, aad = Buffer.from('zoom'), tamper = false } = {}) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad.length) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tamper) ct[0] ^= 1;
  const ivLen = Buffer.from([iv.length]);
  const aadLen = Buffer.alloc(2); aadLen.writeUInt16LE(aad.length);
  const ctLen = Buffer.alloc(4); ctLen.writeUInt32LE(ct.length);
  return Buffer.concat([ivLen, iv, aadLen, aad, ctLen, ct, tag]).toString('base64url');
}

/** A valid in-meeting context payload, expiring in one minute. */
function meetingPayload(overrides = {}) {
  const now = Date.now();
  return { typ: 'meeting', uid: 'zoom-user-1', mid: 'MEETING-A==', ts: now, exp: now + 60_000, ...overrides };
}

/** POST JSON; returns { status, body, cookie } (cookie = first Set-Cookie name=value). */
async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

/**
 * Open a WebSocket and collect messages. Resolves once it opens or closes:
 * { open, code, messages, socket }.
 */
function openWs(url, headers = {}) {
  const WebSocket = require('ws');
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    const messages = [];
    let settled = false;
    const result = { open: false, code: null, messages, socket };
    socket.on('message', (m) => { try { messages.push(JSON.parse(m)); } catch { /* ignore */ } });
    socket.on('open', () => { result.open = true; if (!settled) { settled = true; resolve(result); } });
    socket.on('close', (code) => { result.code = code; if (!settled) { settled = true; resolve(result); } });
    socket.on('error', () => {});
  });
}

/**
 * Connect and wait for the server to close the socket (or time out).
 * Resolves { code, messages }; code is null if the server never closed it.
 */
function wsRejection(url, headers = {}, timeoutMs = 1500) {
  const WebSocket = require('ws');
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    const messages = [];
    const timer = setTimeout(() => { socket.terminate(); resolve({ code: null, messages }); }, timeoutMs);
    socket.on('message', (m) => { try { messages.push(JSON.parse(m)); } catch { messages.push(String(m)); } });
    socket.on('close', (code) => { clearTimeout(timer); resolve({ code, messages }); });
    socket.on('error', () => {});
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST a webhook the way Zoom does: signed with the webhook secret token.
 * Pass { sign: false } to send it without a signature.
 */
async function postWebhook(base, body, { sign = true } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${crypto.createHmac('sha256', TEST_WEBHOOK_TOKEN).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  const headers = sign ? { 'x-zm-signature': signature, 'x-zm-request-timestamp': timestamp } : {};
  return postJson(`${base}/api/rtms/webhook`, body, headers);
}

module.exports = {
  setTestEnv, startServer, internalKey, makeAppContext, meetingPayload,
  postJson, postWebhook, openWs, wsRejection, wait, TEST_CLIENT_SECRET,
};
