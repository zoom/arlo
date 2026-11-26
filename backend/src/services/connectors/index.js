/**
 * Arlo's connectors: named sets of tools backed by an MCP server. GitHub is
 * the first one.
 *
 * A connector exists only when the deployment configured it. For GitHub that
 * is a valid GITHUB_TOKEN and a valid GITHUB_DEFAULT_REPO, both; the
 * repository alone is enough for "open issue 42" (services/agent/tools.js),
 * which calls nothing.
 *
 * The token is read from the configuration here and handed to the MCP client
 * as its Authorization header. It goes nowhere else: not into a log line, not
 * into what githubStatus() says, not into a URL.
 *
 * A second connector: its settings and a create function here, its tools in a
 * file of its own beside github.js, with the same `start()`, `offeredTools()`,
 * `call(name, args)` and `close()`.
 */

const { createMcpClient } = require('./mcpClient');
const { createGithubConnector } = require('./github');
const { readGithubMcpUrl, GITHUB_MCP_HOSTS } = require('./githubConfig');

/** Whether the GitHub connector is configured, and for which repository. Never the token. */
function githubStatus(config) {
  const configured = Boolean(config && config.githubToken && config.githubRepo);
  return { configured, repo: configured ? config.githubRepo : null };
}

/**
 * The GitHub connector for this configuration, or null when it is not
 * configured. Nothing is connected yet: `start()` does that.
 */
function createGithub({ config, fetch, warn = console.warn, timeoutMs } = {}) {
  if (!githubStatus(config).configured) return null;
  // The configuration checked the URL already. It is checked again here: this
  // is the place the token is attached to a request, and the host it goes to
  // must be on the list whatever the caller passed
  const { url, known } = readGithubMcpUrl(config.githubMcpUrl);
  if (!known || !GITHUB_MCP_HOSTS.includes(new URL(url).hostname)) {
    warn('GitHub connector: the MCP server URL is not one of GitHub\'s; the connector is off.');
    return null;
  }
  const client = createMcpClient({
    url,
    headers: { Authorization: `Bearer ${config.githubToken}` },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(fetch === undefined ? {} : { fetch }),
  });
  return createGithubConnector({ client, defaultRepo: config.githubRepo, warn });
}

let github; // undefined until asked for; null when not configured

/** The deployment's GitHub connector (one per process), or null when it is not configured. */
function getGithubConnector() {
  if (github === undefined) {
    // eslint-disable-next-line global-require
    github = createGithub({ config: require('../../config') });
  }
  return github;
}

module.exports = { githubStatus, createGithub, getGithubConnector };
