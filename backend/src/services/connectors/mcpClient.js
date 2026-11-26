/**
 * One connection to one MCP server over Streamable HTTP, for a connector.
 *
 *   const client = createMcpClient({ url, headers, timeoutMs, fetch });
 *   await client.connect();
 *   const tools = await client.listTools();          // [{ name, inputSchema }]
 *   const result = await client.callTool(name, args); // { isError, texts: string[] }
 *   await client.close();
 *
 * What a caller can rely on:
 * - Every request goes to the origin of `url`, over https, and to nowhere
 *   else. A redirect is never followed.
 * - Every call ends within `timeoutMs`.
 * - A response of more than `maxResponseBytes` (200 KB) is refused.
 * - A failure is a McpClientError with one of four codes and a fixed
 *   sentence. Neither it nor anything logged here carries the headers (the
 *   token is one of them), the URL, a response body or the SDK's own message.
 * - A call that fails because the server could not be reached is tried once
 *   more on a new connection. A call marked `retry: false` (a write: sending
 *   it twice could do it twice) is tried again only when the first try is
 *   known not to have reached the server.
 *
 * What the server answers is untrusted: a result is rebuilt as
 * { isError, texts } from its text parts and nothing else is passed on.
 *
 * The SDK is @modelcontextprotocol/client (v2 of the MCP TypeScript SDK). It
 * ships a CommonJS build, so it is required here, when the first client is
 * made: a deployment without a connector never loads it.
 */

const CODES = Object.freeze(['unreachable', 'unauthorized', 'timeout', 'bad_response']);

const SENTENCES = Object.freeze({
  unreachable: 'The MCP server could not be reached.',
  unauthorized: 'The MCP server refused the credentials.',
  timeout: 'The MCP server did not answer in time.',
  bad_response: 'The MCP server gave an answer that could not be used.',
});

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 200 * 1024;
const MAX_TOOLS = 500;
const MAX_TEXT_PARTS = 20;
const CLOSE_WAIT_MS = 1000;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
// A header name and value that cannot end the line or start another header
const HEADER_NAME = /^[A-Za-z0-9-]{1,60}$/;
const HEADER_VALUE = /^[\x20-\x7E]{1,1000}$/;

/** A failure of the connection or of the server's answer: `code` is one of CODES. */
class McpClientError extends Error {
  constructor(code, { delivered = true } = {}) {
    super(SENTENCES[code] || SENTENCES.bad_response);
    this.name = 'McpClientError';
    this.code = CODES.includes(code) ? code : 'bad_response';
    // false when the request is known not to have reached the server
    Object.defineProperty(this, 'delivered', { value: delivered, enumerable: false });
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * What a failure is, as one of the four codes. The SDK's error is read for
 * its kind only; its message, data and cause are dropped here.
 */
function toClientError(error, sdk) {
  if (error instanceof McpClientError) return error;
  const { SdkErrorCode: code } = sdk;
  if (sdk.UnauthorizedError.isInstance(error)) return new McpClientError('unauthorized');
  if (sdk.SdkError.isInstance(error)) {
    const status = sdk.SdkHttpError.isInstance(error) ? error.status : null;
    if (status === 401 || status === 403) return new McpClientError('unauthorized');
    // The server knows no such session (it restarted): nothing was done
    if (status === 404) return new McpClientError('unreachable', { delivered: false });
    if (status === 400 || status === 406 || status === 415 || status === 422) return new McpClientError('bad_response');
    if (status !== null) return new McpClientError('unreachable');
    switch (error.code) {
      case code.RequestTimeout:
        return new McpClientError('timeout');
      case code.ClientHttpAuthentication:
      case code.ClientHttpForbidden:
        return new McpClientError('unauthorized');
      case code.NotConnected:
        return new McpClientError('unreachable', { delivered: false });
      case code.ConnectionClosed:
      case code.SendFailed:
      case code.EraNegotiationFailed:
      case code.ClientHttpFailedToOpenStream:
        return new McpClientError('unreachable');
      default:
        return new McpClientError('bad_response');
    }
  }
  // A JSON-RPC error the server sent as its answer
  if (sdk.ProtocolError.isInstance(error)) return new McpClientError('bad_response');
  const name = error && typeof error === 'object' ? error.name : null;
  if (name === 'AbortError' || name === 'TimeoutError') return new McpClientError('timeout');
  // fetch failed: no route, refused, TLS, a redirect that was not followed
  return new McpClientError('unreachable');
}

/** The headers as they are sent, or a TypeError that names the header and never its value. */
function readHeaders(headers) {
  if (headers === undefined) return {};
  if (!isPlainObject(headers)) throw new TypeError('MCP client: headers must be an object');
  const read = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw new TypeError('MCP client: a header name is not accepted');
    if (typeof value !== 'string' || !HEADER_VALUE.test(value)) throw new TypeError(`MCP client: the value of the header ${name} is not accepted`);
    read[name] = value;
  }
  return read;
}

/** The server's URL, or a TypeError that does not print it: https, no credentials in it. */
function readUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('MCP client: the server URL is not a URL');
  }
  if (parsed.protocol !== 'https:') throw new TypeError('MCP client: the server URL must be https');
  if (parsed.username || parsed.password) throw new TypeError('MCP client: the server URL must not carry credentials');
  return parsed;
}

function createMcpClient({
  url, headers, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES, fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const serverUrl = readUrl(url);
  const sentHeaders = readHeaders(headers);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('MCP client: timeoutMs must be 1 to 120000');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) throw new TypeError('MCP client: maxResponseBytes must be a positive whole number');
  if (typeof fetchImpl !== 'function') throw new TypeError('MCP client: fetch must be a function');
  // eslint-disable-next-line global-require
  const sdk = require('@modelcontextprotocol/client');

  let connection = null; // { client }
  let opening = null; // the connect() that is under way
  const waiting = new Set(); // reject functions of the calls under way

  /** Fails every call under way: the answer on its way cannot be used. */
  function failAll(code) {
    for (const reject of [...waiting]) reject(new McpClientError(code));
  }

  /** The body of a response, cut off (and every call failed) once it is longer than allowed. */
  function capped(body) {
    let seen = 0;
    return body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxResponseBytes) {
          failAll('bad_response');
          controller.error(new McpClientError('bad_response'));
          return;
        }
        controller.enqueue(chunk);
      },
    }));
  }

  /** The only way out: the server's origin, no redirect, a bounded answer. */
  async function guardedFetch(input, init = {}) {
    let target;
    try {
      target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    } catch {
      throw new McpClientError('unreachable', { delivered: false });
    }
    if (target.origin !== serverUrl.origin) throw new McpClientError('unreachable', { delivered: false });
    const response = await fetchImpl(target, { ...init, redirect: 'error' });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      if (response.body) response.body.cancel().catch(() => {});
      failAll('bad_response');
      throw new McpClientError('bad_response');
    }
    if (!response.body) return response;
    return new Response(capped(response.body), { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  /** `work(signal)` with the time limit; the failure, if any, as a McpClientError. */
  async function bounded(work) {
    const abort = new AbortController();
    let timer = null;
    let rejectGuard = null;
    const guard = new Promise((resolve, reject) => {
      rejectGuard = reject;
      timer = setTimeout(() => reject(new McpClientError('timeout')), timeoutMs);
    });
    waiting.add(rejectGuard);
    const working = Promise.resolve().then(() => work(abort.signal));
    // When the guard wins, what the work ends as later is nobody's any more
    working.catch(() => {});
    try {
      return await Promise.race([working, guard]);
    } catch (error) {
      abort.abort();
      throw toClientError(error, sdk);
    } finally {
      clearTimeout(timer);
      waiting.delete(rejectGuard);
    }
  }

  async function shut(client) {
    let timer = null;
    const waited = new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_WAIT_MS); });
    try {
      await Promise.race([Promise.resolve().then(() => client.close()).catch(() => {}), waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function drop() {
    const current = connection;
    connection = null;
    if (current) await shut(current.client);
  }

  async function open() {
    const transport = new sdk.StreamableHTTPClientTransport(new URL(serverUrl.href), {
      requestInit: { headers: { ...sentHeaders }, redirect: 'error' },
      fetch: guardedFetch,
      // A stream that breaks is not picked up again behind the caller's back
      reconnectionOptions: {
        maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1,
      },
    });
    const client = new sdk.Client({ name: 'arlo-connector', version: '1.0.0' }, { capabilities: {} });
    // The SDK reports a broken stream here; the call it belongs to fails by itself
    client.onerror = () => {};
    try {
      await bounded((signal) => client.connect(transport, { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }));
    } catch (error) {
      await shut(client);
      throw error;
    }
    connection = { client };
  }

  /** Connects unless connected. Several callers share one attempt. */
  async function connect() {
    if (connection) return;
    if (!opening) opening = open().finally(() => { opening = null; });
    await opening;
  }

  /**
   * `work(client, signal)` on the connection, at most twice. The connection
   * is given up after any failure but a refusal of the credentials, so the
   * next call starts clean.
   */
  async function request(work, { retry = true } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await connect();
        const { client } = connection;
        return await bounded((signal) => work(client, signal));
      } catch (error) {
        const failure = toClientError(error, sdk);
        if (failure.code !== 'unauthorized') await drop();
        const again = attempt === 1 && failure.code === 'unreachable' && (retry || failure.delivered === false);
        if (!again) throw failure;
      }
    }
  }

  const options = (signal) => ({ signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs });

  /** The server's tools: [{ name, inputSchema }], at most 500, each name a plain tool name. */
  async function listTools() {
    const listed = await request((client, signal) => client.listTools(undefined, options(signal)));
    if (!isPlainObject(listed) || !Array.isArray(listed.tools)) throw new McpClientError('bad_response');
    const tools = [];
    for (const tool of listed.tools.slice(0, MAX_TOOLS)) {
      if (!isPlainObject(tool) || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) continue;
      tools.push({ name: tool.name, inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : {} });
    }
    return tools;
  }

  /**
   * Calls one tool: { isError, texts }. `texts` are the text parts of the
   * answer, in order; everything else in it is dropped. With `retry: false`
   * the call is not sent a second time once it may have reached the server.
   */
  async function callTool(name, args = {}, { retry = true } = {}) {
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || !isPlainObject(args)) throw new McpClientError('bad_response', { delivered: false });
    const result = await request((client, signal) => client.callTool({ name, arguments: args }, options(signal)), { retry });
    if (!isPlainObject(result) || !Array.isArray(result.content)) throw new McpClientError('bad_response');
    const texts = [];
    for (const part of result.content) {
      if (texts.length === MAX_TEXT_PARTS) break;
      if (isPlainObject(part) && part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    }
    return { isError: result.isError === true, texts };
  }

  async function close() {
    await drop();
  }

  return {
    connect, listTools, callTool, close,
  };
}

module.exports = {
  createMcpClient, McpClientError, CODES, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES,
};
