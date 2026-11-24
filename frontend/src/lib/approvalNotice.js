/**
 * A sheet waits for the owner's answer and the panel is not on screen: Zoom
 * shows a notification (`zoomSdk.showNotification`), once per approval.
 *
 * The words are fixed. No name and nothing of what was asked: a notification
 * can appear on a screen that is being shared. NotificationOptions is
 * { type: 'info' | 'warning' | 'error', title, message }, all required.
 *
 * Nothing happens while the panel is visible (the sheet is there to see), on
 * a client without the API, or for an approval already seen here, whether it
 * was announced or not: the same approval coming again is not news. A refusal
 * (Zoom's do-not-disturb is error 10042) is swallowed and not logged.
 */
export const APPROVAL_NOTICE = Object.freeze({ type: 'info', title: 'Arlo', message: 'Arlo needs your OK' });

// The approval ids one panel remembers
const MAX_REMEMBERED = 100;

/**
 * notify(zoomSdk, approvalId, doc = document) → true when Zoom was asked to
 * show the notification. One notifier per panel.
 */
export function createApprovalNotifier({ remember = MAX_REMEMBERED } = {}) {
  const seen = new Set();
  return function notifyApproval(zoomSdk, approvalId, doc = globalThis.document) {
    if (typeof approvalId !== 'string' || approvalId.length === 0) return false;
    if (seen.has(approvalId)) return false;
    if (seen.size >= remember) seen.delete(seen.values().next().value);
    seen.add(approvalId);
    if (doc?.visibilityState === 'visible') return false;
    if (typeof zoomSdk?.showNotification !== 'function') return false;
    try {
      Promise.resolve(zoomSdk.showNotification({ ...APPROVAL_NOTICE })).catch(() => {});
    } catch {
      // Nothing to do about it, and nothing to say
    }
    return true;
  };
}
