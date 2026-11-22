// Live AI endpoints that work in demo mode: the client sends the transcript it
// already has, nothing is read from storage. The LLM call itself is stubbed.
const h = require('./helpers');

h.setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateToken } = require('../src/services/auth');
const openrouter = require('../src/services/openrouter');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const session = () => ({ cookie: `sessionToken=${generateToken({ userId: 'u1', zoomUserId: 'z1' })}` });
const post = (path, body, headers = session()) => h.postJson(`${srv.base}${path}`, body, headers);
const transcript = 'Ana: We ship on Friday.\nBen: I will write the release notes.';

function stub(name, impl) {
  const original = openrouter[name];
  openrouter[name] = impl;
  return () => { openrouter[name] = original; };
}

test('ask-live answers a question from the transcript the client sends', async () => {
  let seen;
  const restore = stub('chatWithTranscript', async (question, text) => { seen = { question, text }; return 'Friday.'; });
  try {
    const res = await post('/api/ai/ask-live', { question: 'When do we ship?', transcript });
    assert.equal(res.status, 200);
    assert.equal(res.body.answer, 'Friday.');
    assert.deepEqual(seen, { question: 'When do we ship?', text: transcript });
  } finally { restore(); }
});

test('ask-live requires a session, a question and a transcript', async () => {
  assert.equal((await post('/api/ai/ask-live', { question: 'q', transcript }, {})).status, 401);
  assert.equal((await post('/api/ai/ask-live', { transcript })).status, 400);
  assert.equal((await post('/api/ai/ask-live', { question: 'q' })).status, 400);
  assert.equal((await post('/api/ai/ask-live', { question: { $gt: '' }, transcript })).status, 400);
  assert.equal((await post('/api/ai/ask-live', { question: 'q'.repeat(1001), transcript })).status, 400);
});

test('ask-live reports an AI failure without leaking the upstream error', async () => {
  const restore = stub('chatWithTranscript', async () => { throw new Error('upstream 401: key sk-secret invalid'); });
  try {
    const res = await post('/api/ai/ask-live', { question: 'When?', transcript });
    assert.equal(res.status, 502);
    assert.equal(JSON.stringify(res.body).includes('sk-secret'), false);
  } finally { restore(); }
});

test('title-live suggests a title from the live transcript', async () => {
  const restore = stub('generateTitle', async () => 'Friday Release Plan');
  try {
    const res = await post('/api/ai/title-live', { transcript, currentTitle: 'My Meeting' });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Friday Release Plan');
  } finally { restore(); }
});

test('title-live requires a session and a transcript, and never returns an empty title', async () => {
  assert.equal((await post('/api/ai/title-live', { transcript }, {})).status, 401);
  assert.equal((await post('/api/ai/title-live', {})).status, 400);
  const restore = stub('generateTitle', async () => '   ');
  try {
    assert.equal((await post('/api/ai/title-live', { transcript })).status, 502);
  } finally { restore(); }
});
