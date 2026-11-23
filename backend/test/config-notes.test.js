// NOTES_INTERVAL_MS and NOTES_MODEL: a mistyped value falls back to the default.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function configFor(extra) {
  const script = `
    require(${JSON.stringify(path.join(__dirname, 'helpers.js'))}).setTestEnv(${JSON.stringify(extra)});
    const warnings = [];
    console.warn = (line) => warnings.push(String(line));
    const config = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))});
    process.stdout.write(JSON.stringify({ interval: config.notesIntervalMs, model: config.notesModel, warnings }));
  `;
  const env = { ...process.env };
  for (const name of ['NOTES_INTERVAL_MS', 'NOTES_MODEL', 'OPENROUTER_MODELS', 'DEFAULT_MODEL']) delete env[name];
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
}
const MODELS = { OPENROUTER_MODELS: 'a/one:free,b/two:free', DEFAULT_MODEL: 'a/one:free' };

test('the notes interval defaults to 45 seconds', () => {
  assert.equal(configFor({}).interval, 45000);
  assert.equal(configFor({ NOTES_INTERVAL_MS: '' }).interval, 45000);
  assert.deepEqual(configFor({}).warnings, []);
});

test('whole milliseconds from 15000 to 600000 are accepted', () => {
  assert.equal(configFor({ NOTES_INTERVAL_MS: '30000' }).interval, 30000);
  assert.equal(configFor({ NOTES_INTERVAL_MS: '15000' }).interval, 15000);
  assert.equal(configFor({ NOTES_INTERVAL_MS: '600000' }).interval, 600000);
});

test('values with units, exponents, signs or out of range fall back to the default with a warning', () => {
  for (const bad of ['45s', '5', '1m', '1e5', '14999', '600001', '-30000', '30000.5', '0x7530', 'abc']) {
    const { interval, warnings } = configFor({ NOTES_INTERVAL_MS: bad });
    assert.equal(interval, 45000, `"${bad}"`);
    assert.equal(warnings.filter((line) => line.includes('NOTES_INTERVAL_MS')).length, 1, `"${bad}"`);
  }
});

test('the notes model is the default model unless an allowed one is named', () => {
  assert.equal(configFor(MODELS).model, 'a/one:free');
  assert.equal(configFor({ ...MODELS, NOTES_MODEL: 'b/two:free' }).model, 'b/two:free');
  assert.equal(configFor({ ...MODELS, NOTES_MODEL: 'paid/model' }).model, 'a/one:free');
});
