/**
 * Connecting a person's GitHub account, from Settings.
 *
 * The server gives a one-time ticket as a URL on this app's own origin; the
 * system browser is sent there and GitHub's own sign-in follows. The URL is
 * opened only when it is exactly this origin, the start path and a ticket of
 * 43 base64url characters: nothing else is ever opened from here. The URL and
 * the ticket are never shown or logged (the ticket signs the browser in to
 * this step as this person).
 */

const CONNECTORS_URL = '/api/connectors';
const START_PATH = '/api/connectors/github/start?ticket=';
const TICKET = /^[A-Za-z0-9_-]{43}$/;
// A GitHub login: 1 to 39 letters, digits and inner hyphens
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** How long "Finish in your browser…" waits for word that the account is connected. */
export const CONNECT_WAIT_MS = 5 * 60 * 1000;
/** How often the server is asked meanwhile whether the account is connected. */
export const CONNECT_POLL_MS = 3000;
/**
 * When no connect waits, looking at the panel again (focus, back in view)
 * asks the server at most this often. Zoom gives a panel the focus many
 * times a minute, and every read counts against the server's rate limit.
 */
export const GLANCE_MIN_MS = 10 * 1000;

/** The server's URL when it is the one this panel may open, else null. */
export function connectStartUrl(url, origin = window.location.origin) {
  if (typeof url !== 'string' || typeof origin !== 'string' || origin.length === 0) return null;
  const prefix = `${origin}${START_PATH}`;
  if (!url.startsWith(prefix)) return null;
  return TICKET.test(url.slice(prefix.length)) ? url : null;
}

/**
 * GET /api/connectors, rebuilt from known fields: { github: { available,
 * connected, login } }, or null when it is not that. Connected only on a
 * server where GitHub is set up; a login that is not a GitHub login is none.
 */
export function parseConnectors(data) {
  const github = data?.github;
  if (github === null || typeof github !== 'object' || Array.isArray(github)) return null;
  if (typeof github.available !== 'boolean' || typeof github.connected !== 'boolean') return null;
  const connected = github.available && github.connected;
  const login = connected && typeof github.login === 'string' && LOGIN.test(github.login) ? github.login : null;
  return { github: { available: github.available, connected, login } };
}

/** The connectors of the signed-in person: the parsed answer, 'signed_out' (401), or null (not known). */
export async function readConnectors() {
  try {
    const res = await fetch(CONNECTORS_URL, { credentials: 'include' });
    if (res.status === 401) return 'signed_out';
    if (!res.ok) return null;
    return parseConnectors(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

/**
 * Send this person's system browser to GitHub's sign-in. `inZoom`: the app
 * runs in the Zoom client, where only Zoom opens the browser.
 * 'opened' | 'failed' (no ticket, or a URL this panel does not open) |
 * 'refused' (Zoom did not open the browser). Nothing is logged.
 */
export async function startGithubConnect({ zoomSdk, inZoom }) {
  let url = null;
  try {
    const res = await fetch(`${CONNECTORS_URL}/github/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: '{}',
    });
    if (!res.ok) return 'failed';
    url = connectStartUrl((await res.json().catch(() => null))?.url);
  } catch {
    return 'failed';
  }
  if (url === null) return 'failed';
  if (!inZoom) {
    // With "noopener" the answer is null whether or not a tab opened
    window.open(url, '_blank', 'noopener,noreferrer');
    return 'opened';
  }
  try {
    if (typeof zoomSdk?.openUrl !== 'function') return 'refused';
    await zoomSdk.openUrl({ url });
    return 'opened';
  } catch {
    return 'refused';
  }
}

/** Disconnect the account on the server: true when it says it is disconnected. */
export async function disconnectGithub() {
  try {
    const res = await fetch(`${CONNECTORS_URL}/github`, { method: 'DELETE', credentials: 'include' });
    if (!res.ok) return false;
    return (await res.json().catch(() => null))?.connected === false;
  } catch {
    return false;
  }
}
