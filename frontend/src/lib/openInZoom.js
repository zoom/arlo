/**
 * "Open Arlo in Zoom": get a deeplink from the server and check it before the
 * browser is sent there.
 */

const ZOOM_HOSTS = ['zoom.us', 'zoom.com'];

/** An https link on one of Zoom's own hosts. Nothing else is ever navigated to. */
export function isZoomLink(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ZOOM_HOSTS.some((zoomHost) => host === zoomHost || host.endsWith(`.${zoomHost}`));
}

/**
 * Ask the server for a link that opens the Zoom client in Arlo for the
 * signed-in user. Resolves with the link; rejects if there is none to trust.
 * The link is per user and short-lived: do not store or log it.
 */
export async function requestDeeplink() {
  const response = await fetch('/api/auth/deeplink', { method: 'POST', credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Could not get a link (${response.status})`);
  }
  const data = await response.json();
  if (!isZoomLink(data?.deeplink)) {
    throw new Error('The server returned a link that is not a Zoom link');
  }
  return data.deeplink;
}
