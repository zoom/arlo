/**
 * The GitHub connector's settings as they are read from the environment: the
 * deployment's token and the URL of GitHub's hosted MCP server.
 *
 * Nothing here calls GitHub and nothing here loads the MCP SDK, so config.js
 * can require it. A value that is set and not accepted is never repaired: the
 * caller ignores it with one warning that does not print it.
 */

// The only hosts the connector ever talks to. A deployment cannot add one with
// a setting: GITHUB_MCP_URL picks a path on a host of this list.
const GITHUB_MCP_HOSTS = Object.freeze(['api.githubcopilot.com']);

// GitHub's hosted MCP server with the issues toolset only (docs/remote-server.md
// in github/github-mcp-server: "/x/{toolset} - Single specific toolset"). The
// narrowest documented choice that can still create an issue.
const DEFAULT_GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/x/issues';

const MAX_URL_CHARS = 200;
// "/mcp", "/mcp/" or a documented path under it ("/mcp/x/issues/readonly")
const MCP_PATH = /^\/mcp(?:\/[A-Za-z0-9_-]+)*\/?$/;
// A GitHub token as GitHub writes them ("ghp_…", "github_pat_…"): letters,
// digits and "_". Nothing that could end a header line or start another one
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/**
 * GITHUB_MCP_URL as it is used: { url, known }. Not set -> the default.
 * Accepted: https, a host of GITHUB_MCP_HOSTS on the default port, a path
 * under /mcp, and nothing else (no user name, password, query or fragment),
 * written exactly as a URL parser reads it back. `known` is false for a value
 * that is set and not accepted; the default is used then.
 */
function readGithubMcpUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return { url: DEFAULT_GITHUB_MCP_URL, known: true };
  const refused = { url: DEFAULT_GITHUB_MCP_URL, known: false };
  if (typeof raw !== 'string' || raw.length > MAX_URL_CHARS) return refused;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return refused;
  }
  if (parsed.protocol !== 'https:' || !GITHUB_MCP_HOSTS.includes(parsed.hostname)) return refused;
  if (parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return refused;
  if (!MCP_PATH.test(parsed.pathname)) return refused;
  // "https://api.githubcopilot.com/mcp/../x", an upper-case host, a tab: what
  // was typed is not what would be called
  if (parsed.href !== raw) return refused;
  return { url: raw, known: true };
}

/** GITHUB_TOKEN as it is used, or null: { token, known }. Never trimmed or repaired. */
function readGithubToken(raw) {
  if (raw === undefined || raw === null || raw === '') return { token: null, known: true };
  if (typeof raw !== 'string' || !TOKEN.test(raw)) return { token: null, known: false };
  return { token: raw, known: true };
}

module.exports = {
  readGithubMcpUrl, readGithubToken, GITHUB_MCP_HOSTS, DEFAULT_GITHUB_MCP_URL,
};
