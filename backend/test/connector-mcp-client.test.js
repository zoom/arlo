// The MCP client a connector talks through: the real SDK on a fetch that is a
// made-up MCP server in this process. Nothing here touches the network.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMcpClient, McpClientError, CODES, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES,
} = require('../src/services/connectors/mcpClient');

const URL_ = 'https://mcp.example.test/mcp/x/issues';
// Made up for this run; shaped like a token so a leak would be found by its text
const TOKEN = `github_pat_${'T'.repeat(30)}`;
const HEADERS = { Authorization: `Bearer ${TOKEN}` };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = (id, result) => json({ jsonrpc: '2.0', id, result });
const text = (value) => ({ content: [{ type: 'text', text: value }] });

/**
 * A fetch that is an MCP server: { fetch, seen }. `seen` has every request as
 * { url, method, headers, redirect, rpc }. `tools` is what tools/list
 * answers; `call(params, request)` what tools/call answers; `before(request)`
 * can answer any request itself (a Response), fail it (throw) or pass (nothing).
 */
function fakeServer({ tools = [], call = () => text('{}'), before = () => undefined } = {}) {
  const seen = [];
  async function fetch(input, init = {}) {
    const headers = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    const method = (init.method || 'GET').toUpperCase();
    const message = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const request = {
      url: String(input), method, headers, redirect: init.redirect, rpc: message && message.method, signal: init.signal,
    };
    seen.push(request);
    const early = await before(request);
    if (early) return early;
    if (method === 'GET') return new Response(null, { status: 405 });
    if (method !== 'POST') return new Response(null, { status: 200 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === 'initialize') {
      return answer(message.id, {
        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' },
      });
    }
    if (message.method === 'tools/list') return answer(message.id, { tools });
    if (message.method === 'tools/call') return answer(message.id, await call(message.params, request));
    return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } });
  }
  return { fetch, seen };
}

const client = (server, extra = {}) => createMcpClient({
  url: URL_, headers: HEADERS, timeoutMs: 2000, fetch: server.fetch, ...extra,
});

/** The McpClientError a promise is rejected with. */
async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpClientError, `a McpClientError, got ${error && error.name}`);
    assert.ok(CODES.includes(error.code));
    // nothing of the request or the answer is in what a caller could log
    const shown = `${error.message} ${error.stack} ${JSON.stringify(error)} ${String(error.cause)}`;
    assert.equal(shown.includes(TOKEN), false);
    assert.equal(/SECRET-BODY|mcp\.example\.test|Bearer/.test(shown), false);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a failure' });
}

const count = (server, rpc) => server.seen.filter((request) => request.rpc === rpc).length;

const TOOL = { name: 'list_issues', description: 'd', inputSchema: { type: 'object', properties: { owner: { type: 'string' } }, required: ['owner'] } };

test('the defaults: ten seconds per call, 200 KB per answer, four error codes', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 10000);
  assert.equal(MAX_RESPONSE_BYTES, 200 * 1024);
  assert.deepEqual([...CODES], ['unreachable', 'unauthorized', 'timeout', 'bad_response']);
});

test('connect, list the tools, call one: every request goes to the server with the headers and follows no redirect', async () => {
  const server = fakeServer({
    // a name that is not a plain tool name is left out
    tools: [TOOL, { name: 'bad name!', inputSchema: { type: 'object' } }, { name: 'other.tool-2', inputSchema: { type: 'object' } }],
    call: (params) => {
      assert.deepEqual(params.arguments, { owner: 'example-org' });
      return {
        content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'two' }],
      };
    },
  });
  const mcp = client(server);
  await mcp.connect();
  await mcp.connect(); // connected already: nothing is sent
  assert.equal(count(server, 'initialize'), 1);

  assert.deepEqual(await mcp.listTools(), [
    { name: 'list_issues', inputSchema: TOOL.inputSchema },
    { name: 'other.tool-2', inputSchema: { type: 'object' } },
  ]);
  assert.deepEqual(await mcp.callTool('list_issues', { owner: 'example-org' }), { isError: false, texts: ['one', 'two'] });

  assert.ok(server.seen.length >= 4);
  for (const request of server.seen) {
    assert.equal(new URL(request.url).origin, 'https://mcp.example.test');
    assert.equal(request.url, URL_);
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  }
  await mcp.close();
});

test('a tool that reports a failure is an answer, not an error: isError with its text', async () => {
  const server = fakeServer({ tools: [TOOL], call: () => ({ isError: true, content: [{ type: 'text', text: 'failed to get issue' }] }) });
  const mcp = client(server);
  assert.deepEqual(await mcp.callTool('list_issues', {}), { isError: true, texts: ['failed to get issue'] });
  await mcp.close();
});

test('a call that is not a tool name with an object of arguments is never sent', async () => {
  const server = fakeServer({ tools: [TOOL] });
  const mcp = client(server);
  for (const [name, args] of [['bad name', {}], ['', {}], [5, {}], ['list_issues', 'owner'], ['list_issues', ['a']], ['list_issues', null]]) {
    assert.equal((await failure(mcp.callTool(name, args))).code, 'bad_response');
  }
  assert.equal(count(server, 'tools/call'), 0);
  await mcp.close();
});

test('timeout: a server that does not answer ends the call in time, and the request is aborted', async () => {
  let aborted = false;
  const server = fakeServer({
    tools: [TOOL],
    before: (request) => {
      if (request.rpc !== 'tools/call') return undefined;
      return new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
      });
    },
  });
  const mcp = client(server, { timeoutMs: 80 });
  const started = Date.now();
  assert.equal((await failure(mcp.callTool('list_issues', {}))).code, 'timeout');
  assert.ok(Date.now() - started < 1500);
  await mcp.close();
  assert.equal(aborted, true);
  // a call that timed out is not sent again
  assert.equal(count(server, 'tools/call'), 1);
});

test('timeout: a server that never answers the handshake', async () => {
  const server = fakeServer({ before: (request) => (request.rpc === 'initialize' ? new Promise(() => {}) : undefined) });
  const mcp = client(server, { timeoutMs: 60 });
  assert.equal((await failure(mcp.connect())).code, 'timeout');
  assert.equal((await failure(mcp.listTools())).code, 'timeout');
});

test('an answer of more than 200 KB is refused, by its declared length or by what arrives', async () => {
  const big = 'x'.repeat(MAX_RESPONSE_BYTES + 1);
  const streamed = fakeServer({ tools: [TOOL], call: () => text(big) });
  const first = client(streamed);
  assert.equal((await failure(first.callTool('list_issues', {}))).code, 'bad_response');
  // not sent again, and the next call works on a new connection
  assert.equal(count(streamed, 'tools/call'), 1);
  await first.close();

  const declared = fakeServer({
    tools: [TOOL],
    before: (request) => (request.rpc === 'tools/call'
      ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } })
      : undefined),
  });
  const second = client(declared);
  assert.equal((await failure(second.callTool('list_issues', {}))).code, 'bad_response');
  await second.close();

  // an answer just under the limit is fine
  const fits = fakeServer({ tools: [TOOL], call: () => text('y'.repeat(MAX_RESPONSE_BYTES - 2000)) });
  const third = client(fits);
  assert.equal((await third.callTool('list_issues', {})).texts[0].length, MAX_RESPONSE_BYTES - 2000);
  await third.close();

  const small = fakeServer({ tools: [TOOL], call: () => text('z'.repeat(600)) });
  const fourth = client(small, { maxResponseBytes: 500 });
  await fourth.connect();
  assert.equal((await failure(fourth.callTool('list_issues', {}))).code, 'bad_response');
  await fourth.close();
});

test('unauthorized: 401 or 403 is the credentials, is not tried again, and says nothing of the token or the body', async () => {
  for (const status of [401, 403]) {
    // the answer points at another host for "how to sign in": nothing is fetched there
    const challenge = { 'www-authenticate': 'Bearer resource_metadata="https://evil.example.test/.well-known/oauth-protected-resource"' };
    const atStart = fakeServer({
      before: (request) => (request.method === 'POST' ? new Response('SECRET-BODY bad credentials', { status, headers: challenge }) : undefined),
    });
    const mcp = client(atStart);
    assert.equal((await failure(mcp.connect())).code, 'unauthorized', String(status));
    assert.equal((await failure(mcp.listTools())).code, 'unauthorized', String(status));
    // one handshake per call, never a second try, and nothing sent anywhere else
    assert.equal(count(atStart, 'initialize'), 2);
    assert.equal(atStart.seen.length, 2);
    for (const request of atStart.seen) assert.equal(request.url, URL_);
    await mcp.close();

    const later = fakeServer({
      tools: [TOOL],
      before: (request) => (request.rpc === 'tools/call' ? new Response('SECRET-BODY', { status }) : undefined),
    });
    const second = client(later);
    assert.equal((await failure(second.callTool('list_issues', {}))).code, 'unauthorized', String(status));
    assert.equal(count(later, 'tools/call'), 1);
    await second.close();
  }
});

test('reconnect once: a call that could not reach the server is sent again on a new connection', async () => {
  let fail = 1;
  const server = fakeServer({
    tools: [TOOL],
    call: () => text('ok'),
    before: (request) => {
      if (request.rpc === 'tools/call' && fail > 0) {
        fail -= 1;
        throw new TypeError('fetch failed');
      }
      return undefined;
    },
  });
  const mcp = client(server);
  await mcp.connect();
  assert.deepEqual(await mcp.callTool('list_issues', {}), { isError: false, texts: ['ok'] });
  assert.equal(count(server, 'tools/call'), 2);
  assert.equal(count(server, 'initialize'), 2);

  // twice in a row: that is the answer, after exactly two tries
  fail = 5;
  assert.equal((await failure(mcp.callTool('list_issues', {}))).code, 'unreachable');
  assert.equal(count(server, 'tools/call'), 4);
  await mcp.close();
});

test('reconnect once: a server that is down when connecting is tried twice', async () => {
  const server = fakeServer({ before: () => { throw new TypeError('fetch failed'); } });
  const mcp = client(server);
  assert.equal((await failure(mcp.listTools())).code, 'unreachable');
  assert.equal(count(server, 'initialize'), 2);
});

test('a write is not sent twice: with retry off only a call that never arrived is sent again', async () => {
  let mode = 'network';
  let fail = 1;
  const server = fakeServer({
    tools: [TOOL],
    call: () => text('created'),
    before: (request) => {
      if (request.rpc !== 'tools/call' || fail === 0) return undefined;
      fail -= 1;
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'gone') return new Response('no such session', { status: 404 });
      return new Response('SECRET-BODY', { status: 502 });
    },
  });
  const mcp = client(server);

  // the connection broke while the call was on its way: it may have been done
  assert.equal((await failure(mcp.callTool('list_issues', {}, { retry: false }))).code, 'unreachable');
  assert.equal(count(server, 'tools/call'), 1);

  mode = 'bad gateway';
  fail = 1;
  assert.equal((await failure(mcp.callTool('list_issues', {}, { retry: false }))).code, 'unreachable');
  assert.equal(count(server, 'tools/call'), 2);

  // the server does not know the session any more: it did nothing, so once more
  mode = 'gone';
  fail = 1;
  assert.deepEqual(await mcp.callTool('list_issues', {}, { retry: false }), { isError: false, texts: ['created'] });
  assert.equal(count(server, 'tools/call'), 4);
  await mcp.close();
});

test('an answer that is not an MCP answer is bad_response', async () => {
  const notAList = fakeServer({ tools: [TOOL], call: () => ({ content: 'not a list' }) });
  const first = client(notAList);
  assert.equal((await failure(first.callTool('list_issues', {}))).code, 'bad_response');
  await first.close();

  const html = fakeServer({
    tools: [TOOL],
    before: (request) => (request.rpc === 'tools/call'
      ? new Response('<html>SECRET-BODY</html>', { status: 200, headers: { 'content-type': 'text/html' } })
      : undefined),
  });
  const second = client(html);
  assert.equal((await failure(second.callTool('list_issues', {}))).code, 'bad_response');
  await second.close();

  // a tools list with an entry that is no tool is refused as a whole
  for (const tools of ['none', [TOOL, 'nonsense'], [{ inputSchema: { type: 'object' } }]]) {
    const badList = fakeServer({ tools });
    const third = client(badList);
    assert.equal((await failure(third.listTools())).code, 'bad_response', JSON.stringify(tools));
    await third.close();
  }
});

test('a JSON-RPC error from the server is bad_response', async () => {
  const server = fakeServer({ tools: [TOOL] });
  const original = server.fetch;
  const fetch = async (input, init = {}) => {
    const message = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (message && message.method === 'tools/call') {
      return json({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'SECRET-BODY unknown tool' } });
    }
    return original(input, init);
  };
  const mcp = createMcpClient({
    url: URL_, headers: HEADERS, timeoutMs: 2000, fetch,
  });
  assert.equal((await failure(mcp.callTool('nope', {}))).code, 'bad_response');
  await mcp.close();
});

test('only https, no credentials in the URL, plain headers; a refusal never prints the value', () => {
  const fetch = async () => { throw new Error('never called'); };
  const refusedUrls = ['http://mcp.example.test/mcp', 'ftp://mcp.example.test/', 'not a url', '', undefined, `https://user:${TOKEN}@mcp.example.test/mcp`];
  for (const url of refusedUrls) {
    assert.throws(() => createMcpClient({ url, headers: HEADERS, fetch }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message.includes(TOKEN) || /example\.test/.test(error.message), false);
      return true;
    }, String(url));
  }
  const refusedHeaders = [
    { Authorization: `Bearer ${TOKEN}\r\nX-Other: 1` }, { Authorization: '' }, { Authorization: 5 }, { 'Bad Name': 'x' }, { Authorization: `Bearer ${TOKEN}é` }, 'Authorization', [],
  ];
  for (const headers of refusedHeaders) {
    assert.throws(() => createMcpClient({ url: URL_, headers, fetch }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    }, JSON.stringify(headers));
  }
  for (const timeoutMs of [0, -1, 1.5, '10', 120001]) assert.throws(() => createMcpClient({ url: URL_, fetch, timeoutMs }), TypeError);
  assert.throws(() => createMcpClient({ url: URL_, fetch: 'fetch' }), TypeError);
});
