// Debug logging must help with debugging without recording what people said,
// who they are, or any credential. It logs the shape of a request, never values.
const h = require('./helpers');

h.setTestEnv({ LOG_LEVEL: 'debug' });

const test = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../src/lib/logger');

function capture(fn) {
  const lines = [];
  const original = { log: console.log, debug: console.debug, info: console.info };
  console.log = console.debug = console.info = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try { fn(); } finally { Object.assign(console, original); }
  return lines.join('\n');
}

const request = {
  method: 'POST',
  path: '/api/rtms/broadcast',
  originalUrl: '/api/rtms/broadcast?code=OAUTH-CODE-123&state=STATE-456',
  query: { code: 'OAUTH-CODE-123', state: 'STATE-456' },
  headers: {
    'content-type': 'application/json',
    cookie: 'sessionToken=SESSION-JWT',
    'x-arlo-internal-key': 'INTERNAL-KEY-VALUE',
    'x-zm-signature': 'v0=SIGNATURE',
  },
  body: {
    meetingId: 'MEETING-UUID-789==',
    segment: { speakerLabel: 'Ana Ruiz', text: 'My account number is 4111 1111 1111 1111', seqNo: 4 },
  },
};

test('debug request logging records the shape of a request and none of its values', () => {
  const output = capture(() => logger.logRequest(request));

  assert.match(output, /POST/);
  assert.match(output, /\/api\/rtms\/broadcast/);
  assert.match(output, /meetingId/);   // field names help debugging
  assert.match(output, /segment/);

  for (const secret of [
    'My account number', '4111', 'Ana Ruiz', 'MEETING-UUID-789', 'OAUTH-CODE-123', 'STATE-456',
    'SESSION-JWT', 'INTERNAL-KEY-VALUE', 'SIGNATURE',
  ]) {
    assert.equal(output.includes(secret), false, `logged "${secret}"`);
  }
});

test('it copes with requests that have no body or query', () => {
  const output = capture(() => logger.logRequest({ method: 'POST', path: '/api/x', originalUrl: '/api/x', headers: {} }));
  assert.match(output, /\/api\/x/);
});
