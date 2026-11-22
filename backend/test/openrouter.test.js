// The OpenRouter client: model fallback, dead models, reasoning models and
// rate limits. Network is stubbed; no request leaves the machine.
const h = require('./helpers');

h.setTestEnv({ OPENROUTER_MODELS: 'a/one:free,b/two:free,c/three:free', DEFAULT_MODEL: 'a/one:free' });

const test = require('node:test');
const assert = require('node:assert/strict');
const openrouter = require('../src/services/openrouter');

const realFetch = global.fetch;
let calls;

/** Stub fetch with a per-model responder: model => { status, content, finish } */
function stubModels(responder) {
  calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const { status = 200, content = '', finish = 'stop' } = responder(body.model) || {};
    return new Response(JSON.stringify(status === 200
      ? { choices: [{ message: { content }, finish_reason: finish }] }
      : { error: { message: 'Provider returned error' } }), { status });
  };
}

test.beforeEach(() => openrouter._resetForTests());
test.after(() => { global.fetch = realFetch; });

const modelsCalled = () => calls.map((c) => c.model);

test('asks models not to spend the answer budget on reasoning', async () => {
  stubModels(() => ({ content: 'Friday Release Plan' }));
  await openrouter.generateTitle('Ana: we ship Friday', 'Meeting');
  assert.deepEqual(calls[0].reasoning, { enabled: false });
});

test('falls through to the next model when one is gone, and stops asking the dead one', async () => {
  stubModels((model) => (model === 'a/one:free' ? { status: 404 } : { content: 'answer' }));
  assert.equal(await openrouter.chatWithTranscript('q', 't'), 'answer');
  assert.deepEqual(modelsCalled(), ['a/one:free', 'b/two:free']);

  calls = [];
  assert.equal(await openrouter.chatWithTranscript('q', 't'), 'answer');
  assert.deepEqual(modelsCalled(), ['b/two:free']);
});

test('an empty answer (budget used up before any text) moves on to the next model', async () => {
  stubModels((model) => (model === 'a/one:free' ? { content: '', finish: 'length' } : { content: 'answer' }));
  assert.equal(await openrouter.chatWithTranscript('q', 't'), 'answer');
  assert.deepEqual(modelsCalled(), ['a/one:free', 'b/two:free']);
});

test('when every model is rate limited the error says so', async () => {
  stubModels(() => ({ status: 429 }));
  await assert.rejects(openrouter.chatWithTranscript('q', 't'), (error) => error.code === 'rate_limited');
  assert.equal(modelsCalled().length, 3);
});

test('a rate-limited model is not treated as gone', async () => {
  stubModels(() => ({ status: 429 }));
  await assert.rejects(openrouter.chatWithTranscript('q', 't'));
  stubModels(() => ({ content: 'answer' }));
  await openrouter.chatWithTranscript('q', 't');
  assert.deepEqual(modelsCalled(), ['a/one:free']);
});

test('if every configured model is gone, they are all tried again rather than failing forever', async () => {
  stubModels(() => ({ status: 404 }));
  await assert.rejects(openrouter.chatWithTranscript('q', 't'), (error) => error.code === 'no_models');
  stubModels(() => ({ content: 'back' }));
  assert.equal(await openrouter.chatWithTranscript('q', 't'), 'back');
});
