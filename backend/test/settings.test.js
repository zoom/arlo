// Public server settings the panel reads at startup.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const test = require('node:test');
const assert = require('node:assert/strict');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

test('automatic start is off unless the deployment turns it on', async () => {
  const res = await fetch(`${srv.base}/api/auth/settings`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.features.autoStart, false);
});

test('the privacy notice says what is held and when it is deleted', async () => {
  const body = await (await fetch(`${srv.base}/api/auth/settings`)).json();
  assert.match(body.privacyNotice, /in memory while the meeting is running/);
  assert.match(body.privacyNotice, /deleted when the meeting ends/);
  assert.doesNotMatch(body.privacyNotice, /never stored/);
});
