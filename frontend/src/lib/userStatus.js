/**
 * Who is using the app: a full user, or a guest?
 *
 * Guest mode only exists inside a meeting, where someone can open an app they
 * have not added. There, Zoom's getUserContext() decides, and not being able
 * to ask means guest.
 *
 * Outside a meeting (the Apps tab, where a deeplink lands) the person opened
 * their own app, and getUserContext() cannot be relied on. They are never a
 * guest: the app signs them in with authorize(), which is silent when they
 * have already authorized it.
 */

const MEETING_CONTEXTS = new Set(['inMeeting', 'inWebinar', 'inImmersive', 'inCollaborate', 'inCamera']);

export const isMeetingContext = (runningContext) => MEETING_CONTEXTS.has(runningContext);

/**
 * `reported` is getUserContext().status, or null when the call failed.
 * Returns the status the app should act on and whether to use the guest flow.
 */
export function resolveUserStatus({ runningContext, reported }) {
  if (!isMeetingContext(runningContext)) {
    return { status: 'authorized', isGuest: false };
  }
  const status = reported || 'unauthenticated';
  return { status, isGuest: status !== 'authorized' };
}
