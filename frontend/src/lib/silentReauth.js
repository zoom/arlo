/**
 * Decide whether to sign the user in without showing "Connect with Zoom".
 *
 * Zoom remembers that the user authorized Arlo, but Arlo's session lives in
 * backend memory and is lost on every restart. When Zoom reports the user as
 * `authorized`, zoomSdk.authorize() runs a non-interactive OAuth flow (no
 * consent screen), so it is safe to call without a click. For any other
 * status authorize() would open a consent screen, so the user must ask for it.
 */
export function shouldSilentReauth({
  isBrowser,
  authLoading,
  isAuthenticated,
  sdkConfigured,
  sdkError,
  userContextStatus,
  alreadyAttempted,
}) {
  if (isBrowser || authLoading || isAuthenticated) return false;
  if (!sdkConfigured || sdkError) return false;
  if (alreadyAttempted) return false;
  return userContextStatus === 'authorized';
}
