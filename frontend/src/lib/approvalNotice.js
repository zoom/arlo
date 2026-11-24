/**
 * A sheet waits for the owner's answer and the panel is not on screen: Zoom
 * shows a notification (`zoomSdk.showNotification`), once per approval and
 * at most once in 30 seconds per panel.
 *
 * The words are fixed. No name and nothing of what was asked: a notification
 * can appear on a screen that is being shared. NotificationOptions is
 * { type: 'info' | 'warning' | 'error', title, message }, all required.
 *
 * Nothing happens while the panel is visible (the sheet is there to see), on
 * a client without the API, or for an approval already seen here, whether it
 * was announced or not: the same approval coming again is not news. A refusal
 * (Zoom's do-not-disturb is error 10042) is swallowed and not logged.
 *
 * Anyone in the meeting can say "Arlo, …" and each request is a sheet, so the
 * notifications are spaced too: after one was asked of Zoom, none for
 * MIN_GAP_MS, whatever the approval. One held back is not shown later (it is
 * remembered as seen); the sheet itself is on the panel all the same.
 */
export const APPROVAL_NOTICE = Object.freeze({ type: 'info', title: 'Arlo', message: 'Arlo needs your OK' });

// The approval ids one panel remembers
const MAX_REMEMBERED = 100;
// From one notification to the next, per panel
const MIN_GAP_MS = 30_000;

/**
 * notify(zoomSdk, approvalId, doc = document) → true when Zoom was asked to
 * show the notification. One notifier per panel. `now` is the clock (tests);
 * with a clock that gives no time nothing is shown.
 */
export function createApprovalNotifier({ remember = MAX_REMEMBERED, minGapMs = MIN_GAP_MS, now = Date.now } = {}) {
  const seen = new Set();
  // When Zoom was last asked to show one, or null
  let lastAt = null;
  const timeNow = () => {
    try {
      const at = now();
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  };
  return function notifyApproval(zoomSdk, approvalId, doc = globalThis.document) {
    if (typeof approvalId !== 'string' || approvalId.length === 0) return false;
    if (seen.has(approvalId)) return false;
    if (seen.size >= remember) seen.delete(seen.values().next().value);
    seen.add(approvalId);
    if (doc?.visibilityState === 'visible') return false;
    if (typeof zoomSdk?.showNotification !== 'function') return false;
    const at = timeNow();
    if (at === null || (lastAt !== null && !(at - lastAt >= minGapMs))) return false;
    lastAt = at;
    try {
      Promise.resolve(zoomSdk.showNotification({ ...APPROVAL_NOTICE })).catch(() => {});
    } catch {
      // Nothing to do about it, and nothing to say
    }
    return true;
  };
}
