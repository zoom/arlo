/**
 * Arlo's connectors: named sets of tools that act outside the meeting, as the
 * person who connected their own account. GitHub is the first one.
 *
 * A connector exists only when the deployment configured it. For GitHub that
 * is the GitHub App a user connects through (GITHUB_APP_CLIENT_ID,
 * GITHUB_APP_CLIENT_SECRET) and GITHUB_DEFAULT_REPO, all three; the
 * repository alone is enough for "open issue 42" (services/agent/tools.js),
 * which calls nothing.
 *
 * There is no token of the deployment's. Each call runs with the token of one
 * user, taken from the connection store for that call
 * (services/connectors/githubConnections.js) and sent to api.github.com
 * (services/connectors/githubRest.js). It goes nowhere else.
 *
 * services/connectors/mcpClient.js is a generic MCP client that no connector
 * uses in this build (GitHub is called through its REST API).
 *
 * A second connector: its settings and a create function here, its tools in a
 * file of its own beside github.js, with the same `call(name, args, { userId })`.
 */

const { createGithubConnector } = require('./github');
const { createGithubRest } = require('./githubRest');

/** Whether the GitHub connector is configured, and for which repository. Never a secret. */
function githubStatus(config) {
  const configured = Boolean(config && config.githubAppClientId && config.githubAppClientSecret && config.githubRepo);
  return { configured, repo: configured ? config.githubRepo : null };
}

/**
 * The GitHub connector for this configuration, or null when it is not
 * configured. `connections`: the per-user store; the running server's when
 * not given, asked for at the time of each call (tests put another in place).
 */
function createGithub({
  config, fetch, timeoutMs, connections,
} = {}) {
  if (!githubStatus(config).configured) return null;
  // eslint-disable-next-line global-require
  const store = () => connections || require('./githubConnections').getGithubConnections();
  return createGithubConnector({
    rest: createGithubRest({ ...(fetch === undefined ? {} : { fetch }), ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
    connections: {
      getAccessToken: (userId) => store().getAccessToken(userId),
      refreshAccessToken: (userId, refused) => store().refreshAccessToken(userId, refused),
      drop: (userId) => store().drop(userId),
      status: (userId) => store().status(userId),
    },
    defaultRepo: config.githubRepo,
  });
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

/** Tests: put another connector in place, or none (undefined: built again from the configuration). */
function _setForTests(replacement) {
  github = replacement;
}

module.exports = {
  githubStatus, createGithub, getGithubConnector, _setForTests,
};
