/**
 * The GitHub connector's settings as they are read from the environment: the
 * GitHub App a user connects their own account through. There is no token of
 * the deployment's (the repository, GITHUB_DEFAULT_REPO, is read by lib/github.js).
 *
 * Nothing here calls GitHub, so config.js can require it. A value that is set
 * and not accepted is never repaired: the caller ignores it with one warning
 * that does not print it.
 */

// The GitHub App a user connects their own account through (routes/connectors.js).
// The client ID as GitHub writes them ("Iv1.…", "Iv23…"); the client secret is
// a secret: letters, digits and "_", nothing that could end a header line
const APP_CLIENT_ID = /^[A-Za-z0-9._-]{10,60}$/;
const APP_CLIENT_SECRET = /^[A-Za-z0-9_]{20,100}$/;

/** GITHUB_APP_CLIENT_ID as it is used, or null: { clientId, known }. Never trimmed or repaired. */
function readGithubAppClientId(raw) {
  if (raw === undefined || raw === null || raw === '') return { clientId: null, known: true };
  if (typeof raw !== 'string' || !APP_CLIENT_ID.test(raw)) return { clientId: null, known: false };
  return { clientId: raw, known: true };
}

/** GITHUB_APP_CLIENT_SECRET as it is used, or null: { clientSecret, known }. Never trimmed or repaired. */
function readGithubAppClientSecret(raw) {
  if (raw === undefined || raw === null || raw === '') return { clientSecret: null, known: true };
  if (typeof raw !== 'string' || !APP_CLIENT_SECRET.test(raw)) return { clientSecret: null, known: false };
  return { clientSecret: raw, known: true };
}

module.exports = { readGithubAppClientId, readGithubAppClientSecret };
