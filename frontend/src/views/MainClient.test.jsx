import { render, screen, waitFor, act } from '@testing-library/react';
import App from '../App';
import { createZoomSdk, json, mockFetch, resetHarness } from '../test/harness';

// Arlo opened in the Zoom client outside a meeting (the Apps tab, where the
// "Open Arlo in Zoom" deeplink lands), with no session yet.

afterEach(resetHarness);

function openInAppsTab(sdkOptions) {
  const sdk = createZoomSdk({ runningContext: 'inMainClient', ...sdkOptions });
  window.zoomSdk = sdk;
  localStorage.setItem('arlo-vertical', 'notes');
  window.location.hash = '#/';
  render(<App />);
  return sdk;
}

test('it signs the user in instead of showing the guest screen with a button that cannot work', async () => {
  let signedIn = false;
  const user = { id: 'user-1', displayName: 'Ana' };
  mockFetch({
    '/api/auth/me': () => (signedIn ? json({ user }) : json({ error: 'Unauthorized' }, 401)),
    '/api/auth/authorize': () => json({ codeChallenge: 'challenge', state: 'state-1' }),
    'POST /api/auth/callback': () => { signedIn = true; return json({ user }); },
  });
  // Outside a meeting Zoom cannot report the user's status
  const sdk = openInAppsTab({ userContextFails: true });

  await waitFor(() => expect(sdk.authorize).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button', { name: 'Sign in with Zoom' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add Arlo to Your Account' })).not.toBeInTheDocument();

  await act(async () => { sdk.emit('onAuthorized', { code: 'auth-code', result: true }); });
  // Signed in: the home screen, not the guest or sign-in screens
  await waitFor(() => expect(window.location.hash).toBe('#/home'));
});
