import { shouldSilentReauth } from './silentReauth';

// The situation R5 is about: Zoom says the app is authorized, but Arlo has no
// session (backend restarted and lost its in-memory tokens).
const lostSession = {
  isBrowser: false,
  authLoading: false,
  isAuthenticated: false,
  sdkConfigured: true,
  sdkError: null,
  userContextStatus: 'authorized',
  alreadyAttempted: false,
};

describe('shouldSilentReauth', () => {
  test('signs in silently when Zoom says authorized but Arlo has no session', () => {
    expect(shouldSilentReauth(lostSession)).toBe(true);
  });

  test('tries only once per page load so a failing authorize cannot loop', () => {
    expect(shouldSilentReauth({ ...lostSession, alreadyAttempted: true })).toBe(false);
  });

  test.each(['unauthenticated', 'authenticated', 'unauthorized', null, undefined])(
    'never auto-authorizes a user Zoom reports as %s (would open a consent screen unasked)',
    (userContextStatus) => {
      expect(shouldSilentReauth({ ...lostSession, userContextStatus })).toBe(false);
    },
  );

  test('does nothing while the session check is still running', () => {
    expect(shouldSilentReauth({ ...lostSession, authLoading: true })).toBe(false);
  });

  test('does nothing when the session is still valid', () => {
    expect(shouldSilentReauth({ ...lostSession, isAuthenticated: true })).toBe(false);
  });

  test('does nothing outside Zoom (browser uses the redirect OAuth flow)', () => {
    expect(shouldSilentReauth({ ...lostSession, isBrowser: true })).toBe(false);
  });

  test('waits for the Zoom SDK to be configured', () => {
    expect(shouldSilentReauth({ ...lostSession, sdkConfigured: false })).toBe(false);
  });

  test('does nothing when the Zoom SDK failed to configure', () => {
    expect(shouldSilentReauth({ ...lostSession, sdkError: 'config failed' })).toBe(false);
  });
});
