// Public server settings the panel reads at startup.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });
// The default is what is tested here, whatever the shell that runs the tests has set
delete process.env.ALLOW_OWN_ARLO_STREAM;

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** `config.ownStream` in a fresh process with ALLOW_OWN_ARLO_STREAM set to `value` (undefined: not set). */
function ownStreamFor(value) {
  const script = `
    require(${JSON.stringify(path.join(__dirname, 'helpers.js'))}).setTestEnv(${value === undefined ? '' : `{ ALLOW_OWN_ARLO_STREAM: ${JSON.stringify(value)} }`});
    process.stdout.write(String(require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))}).ownStream));
  `;
  const env = { ...process.env };
  delete env.ALLOW_OWN_ARLO_STREAM;
  return execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
}

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

test('automatic start is off unless the deployment turns it on', async () => {
  const res = await fetch(`${srv.base}/api/auth/settings`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.features.autoStart, false);
});

test('a second person starting their own Arlo is offered unless the deployment turns it off', async () => {
  const body = await (await fetch(`${srv.base}/api/auth/settings`)).json();
  assert.equal(body.features.ownStream, true);
  assert.equal(ownStreamFor(undefined), 'true');
  assert.equal(ownStreamFor(''), 'true');
  assert.equal(ownStreamFor('true'), 'true');
});

test('ALLOW_OWN_ARLO_STREAM=false turns "Use Arlo yourself" off, and only that exact value does', () => {
  assert.equal(ownStreamFor('false'), 'false');
  for (const other of ['0', 'no', 'off', 'FALSE', ' false']) assert.equal(ownStreamFor(other), 'true', `"${other}"`);
});

test('without GITHUB_DEFAULT_REPO the settings say there is no repository', async () => {
  const body = await (await fetch(`${srv.base}/api/auth/settings`)).json();
  assert.deepEqual(body.features.github, { repo: null });
});

test('the privacy notice says what is held and when it is deleted', async () => {
  const body = await (await fetch(`${srv.base}/api/auth/settings`)).json();
  assert.match(body.privacyNotice, /in memory while the meeting is running/);
  assert.match(body.privacyNotice, /deleted when the meeting ends/);
  assert.doesNotMatch(body.privacyNotice, /never stored/);
});
