// MEETING_FLUSH_GRACE_MS: a mistyped value must not shrink the grace period.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function graceFor(value) {
  const script = `
    require(${JSON.stringify(path.join(__dirname, 'helpers.js'))}).setTestEnv(${value === undefined ? '' : `{ MEETING_FLUSH_GRACE_MS: ${JSON.stringify(value)} }`});
    console.warn = () => {};
    process.stdout.write(String(require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))}).meetingFlushGraceMs));
  `;
  const env = { ...process.env };
  delete env.MEETING_FLUSH_GRACE_MS;
  return Number(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
}

test('the default is two minutes', () => {
  assert.equal(graceFor(undefined), 120000);
  assert.equal(graceFor(''), 120000);
});

test('whole milliseconds in range are accepted', () => {
  assert.equal(graceFor('200'), 200);
  assert.equal(graceFor('3600000'), 3600000);
});

test('values with units, exponents, signs or out of range fall back to the default', () => {
  for (const bad of ['2m', '120s', '1e5', '10abc', '0x10', '0', '50', '-1', '3600001', 'abc']) {
    assert.equal(graceFor(bad), 120000, `"${bad}"`);
  }
});
