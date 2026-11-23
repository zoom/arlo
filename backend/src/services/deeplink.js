/**
 * "Open Arlo in Zoom": a link that opens the Zoom client straight into the app.
 *
 * First choice is Zoom's deeplink API (POST /v2/zoomapp/deeplink), called with
 * the user's own token. It works for unpublished apps too. Zoom's API reference
 * lists the app:deeplink:write scope for it, but that scope cannot be added to
 * a Zoom App in the Marketplace UI and, per the app owner, does not need to be
 * registered. If the call is refused or the user has no usable token, the
 * fallback is Zoom's documented Marketplace launch URL, which needs no token
 * but only works for a published app the user has added.
 *
 * A deeplink is per user and short-lived: it is generated on demand, never
 * cached and never logged.
 */
const config = require('../config');
const { zoomPost } = require('./zoomApi');

const MAX_LINK_CHARS = 2000;

/** Zoom's own hosts only. A link from anywhere else is never passed to a browser. */
function isZoomLink(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LINK_CHARS) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const zoomHost = String(config.zoomHost || 'zoom.us').toLowerCase();
  return host === zoomHost || host.endsWith(`.${zoomHost}`) || host === 'zoom.com' || host.endsWith('.zoom.com');
}

/** Opens the app outside a meeting (Apps tab); in a meeting Zoom opens it there. */
function marketplaceLaunchLink() {
  return `https://marketplace.${config.zoomHost || 'zoom.us'}/zoomapp/${encodeURIComponent(config.zoomClientId)}/context/panel/target/launch/deeplink`;
}

/** Returns { deeplink, source: 'zoom' | 'marketplace' }. Never throws. */
async function createDeeplink(userId) {
  try {
    // type 1: open in the current meeting if there is one, otherwise the Apps tab
    const data = await zoomPost(userId, '/zoomapp/deeplink', { action: 'open', type: 1 });
    if (isZoomLink(data?.deeplink)) {
      return { deeplink: data.deeplink, source: 'zoom' };
    }
    console.warn('Zoom deeplink API returned no usable link; using the Marketplace launch link');
  } catch (error) {
    // Status and reason code only: never the response body or a token
    console.warn(`Zoom deeplink API unavailable (${error.code || 'error'}${error.status ? ` ${error.status}` : ''}); using the Marketplace launch link`);
  }
  return { deeplink: marketplaceLaunchLink(), source: 'marketplace' };
}

module.exports = { createDeeplink, isZoomLink, marketplaceLaunchLink };
