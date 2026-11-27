#!/usr/bin/env node
/**
 * Is "Connect GitHub" set up on this deployment, and which of GitHub's
 * endpoints take a user's own token?
 *
 *   node scripts/connector-check.js
 *       prints whether the GitHub App settings and the repository are set
 *       (never their values). Nothing is called.
 *
 *   node scripts/connector-check.js --user-token-from-stdin < file-with-one-token
 *       also reads ONE token from standard input (a GitHub App user token,
 *       "ghu_…") and makes two calls with it:
 *         - REST:  GET https://api.github.com/repos/<repo>/issues?per_page=1
 *         - MCP:   tools/list at https://api.githubcopilot.com/mcp/x/issues
 *       and prints only the REST status code and, for MCP, "ok" or an error
 *       code. (In the backend container:
 *       docker-compose exec -T backend node scripts/connector-check.js --user-token-from-stdin)
 *
 * The token is read from standard input only: never a command-line argument
 * (those show in the process list and the shell history) and never an
 * environment variable. It is never printed, and nothing GitHub answers is
 * printed: not a repository, an issue, a tool name or an error text. Both
 * hosts are GitHub's own and fixed here; no setting changes them.
 *
 * Arlo itself uses the REST API. The MCP call only answers whether GitHub's
 * hosted MCP server takes such a token, for a later build.
 *
 * Exit code 0 when everything is set (and, with a token, REST answered 200);
 * 1 otherwise.
 */
const path = require('node:path');

// GitHub's hosted MCP server with the issues toolset only
const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/x/issues';
const FLAG = '--user-token-from-stdin';
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const CODE = /^[a-z_]{1,30}$/;
const MAX_STDIN_CHARS = 1000;

/** Everything on standard input, as text; null when it is longer than a token could be. */
async function readAll(stream) {
  let text = '';
  for await (const chunk of stream) {
    text += String(chunk);
    if (text.length > MAX_STDIN_CHARS) return null;
  }
  return text;
}

async function main({
  argv = process.argv.slice(2), stdin = process.stdin, print = console.log, fetch,
} = {}) {
  const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);
  // eslint-disable-next-line global-require
  const config = require(src('config.js'));

  if (argv.some((arg) => arg !== FLAG)) {
    // Not echoed: someone may have passed a token as an argument
    print(`Unknown argument. The only one is ${FLAG}; a token is never given as an argument.`);
    return 1;
  }
  const state = (value) => (value ? 'set' : 'not set (or not accepted)');
  print(`GITHUB_APP_CLIENT_ID: ${state(config.githubAppClientId)}`);
  print(`GITHUB_APP_CLIENT_SECRET: ${state(config.githubAppClientSecret)}`);
  print(`GITHUB_DEFAULT_REPO: ${state(config.githubRepo)}`);
  print(`Connect GitHub: ${config.githubConnectAvailable ? 'available' : 'not available (it needs all three)'}`);
  if (!argv.includes(FLAG)) return config.githubConnectAvailable ? 0 : 1;

  if (!config.githubRepo) {
    print('No repository is set: nothing was called.');
    return 1;
  }
  const given = await readAll(stdin);
  const token = given === null ? null : given.trim();
  if (token === null || !TOKEN.test(token)) {
    print('Standard input did not hold one GitHub token: nothing was called.');
    return 1;
  }

  /* eslint-disable global-require */
  const { createGithubRest } = require(src('services', 'connectors', 'githubRest.js'));
  const { createMcpClient } = require(src('services', 'connectors', 'mcpClient.js'));
  /* eslint-enable global-require */

  let rest;
  try {
    // The same client Arlo uses; the one query parameter that is not Arlo's own is the page size
    const answer = await createGithubRest(fetch ? { fetch } : {}).request({
      method: 'GET', path: `/repos/${config.githubRepo}/issues`, query: { per_page: 1 }, token,
    });
    rest = String(answer.status);
  } catch (error) {
    rest = error && typeof error.code === 'string' && CODE.test(error.code) ? error.code : 'error';
  }
  print(`REST GET /repos/<repo>/issues?per_page=1: ${rest}`);

  let mcp = 'ok';
  let client = null;
  try {
    client = createMcpClient({ url: GITHUB_MCP_URL, headers: { Authorization: `Bearer ${token}` }, ...(fetch ? { fetch } : {}) });
    await client.listTools();
  } catch (error) {
    mcp = error && typeof error.code === 'string' && CODE.test(error.code) ? error.code : 'error';
  } finally {
    try {
      if (client) await client.close();
    } catch {
      // closing is best effort
    }
  }
  print(`MCP tools/list: ${mcp}`);
  return rest === '200' ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
    // Should a connection linger after close(), the script still ends
    setTimeout(() => process.exit(code), 2000).unref();
  }, () => {
    // Whatever went wrong, its message is not printed: it is not ours
    console.error('connector-check failed unexpectedly.');
    process.exitCode = 1;
  });
}

module.exports = { main, GITHUB_MCP_URL };
