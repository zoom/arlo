import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
} from '../test/harness';

// The session ends while the panel is open in a meeting. The next API call is
// refused; the app must notice, sign in again without a click (Zoom still
// reports the user as authorized), and come back with the transcript intact.

const server = () => FakeWebSocket.last;
const send = (message) => act(() => { server().serverSend(message); });

afterEach(resetHarness);

test('a session that expires mid-meeting is renewed silently and the transcript is kept', async () => {
  let sessionValid = true;
  const user = { id: 'user-1', displayName: 'Ana' };
  mockFetch({
    '/api/auth/me': () => (sessionValid ? json({ user }) : json({ error: 'Unauthorized' }, 401)),
    '/api/auth/authorize': () => json({ codeChallenge: 'challenge', state: 'state-1' }),
    'POST /api/auth/callback': () => { sessionValid = true; return json({ user }); },
    'POST /api/ai/title-live': () => (sessionValid ? json({ title: 'Renewed' }) : json({ error: 'Unauthorized' }, 401)),
  });
  const { sdk } = renderInMeeting();
  await screen.findByText('Transcription not started');
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.segment(1, 'This was said before the session ended, and it must survive.'));
  await screen.findByText('Transcribing');

  // The session ends; the next API call is refused
  sessionValid = false;
  await userEvent.click(screen.getByRole('button', { name: 'Suggest a title with AI' }));

  // The app notices and signs in again without asking
  expect(await screen.findByText('Signing you in…')).toBeInTheDocument();
  await waitFor(() => expect(sdk.authorize).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button', { name: /Connect with Zoom/ })).not.toBeInTheDocument();

  // Zoom answers the non-interactive authorize; the app returns to the meeting
  await act(async () => { sdk.emit('onAuthorized', { code: 'auth-code', result: true }); });
  expect(await screen.findByText('This was said before the session ended, and it must survive.')).toBeInTheDocument();
  expect(screen.getByText('Transcribing')).toBeInTheDocument();
});
