/**
 * Notice when the session is gone.
 *
 * The app makes its API calls with plain fetch() from many places. A session
 * that expires while the panel is open (24 hours, or a restart the restore
 * cookie could not cover) made every one of them fail quietly with 401. This
 * watches fetch for that and reports it once, so the app can sign in again.
 *
 * It only observes: callers get their response or error exactly as before.
 */

// 401 from these is not "the session is gone":
//  - /api/auth/*: signing in, the session check itself, meeting access
//  - by-zoom-id routes: they depend on meeting access, not on the session
const NOT_SESSION_ROUTES = [/^\/api\/auth\//, /^\/api\/meetings\/by-zoom-id\//];
const REPORT_INTERVAL_MS = 5000;

function apiPath(input) {
  const raw = typeof input === 'string' ? input : input?.url;
  if (!raw) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return url.pathname.startsWith('/api/') ? url.pathname : null;
  } catch {
    return null;
  }
}

/**
 * Start watching. `onLost` is called (at most once per 5 seconds) when an API
 * call is refused with 401. Returns a function that stops watching.
 */
export function watchForSessionLoss(onLost) {
  const originalFetch = globalThis.fetch;
  let lastReport = -Infinity;

  const watched = async (input, init) => {
    const response = await originalFetch(input, init);
    if (response.status === 401) {
      const path = apiPath(input);
      const isSessionRoute = path && !NOT_SESSION_ROUTES.some((pattern) => pattern.test(path));
      if (isSessionRoute && Date.now() - lastReport > REPORT_INTERVAL_MS) {
        lastReport = Date.now();
        try {
          onLost();
        } catch {
          // The watcher must never break the call it is observing
        }
      }
    }
    return response;
  };

  globalThis.fetch = watched;
  return () => {
    if (globalThis.fetch === watched) globalThis.fetch = originalFetch;
  };
}
