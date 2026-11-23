import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FakeWebSocket, mockFetch, renderInMeeting, resetHarness } from '../test/harness';

// The vertical is changed in Settings and nowhere else: nothing in the header
// sends a user to the chooser or resets their choice.

afterEach(() => { resetHarness(); localStorage.clear(); });

test('the header back arrow in a meeting goes home and keeps the saved vertical', async () => {
  mockFetch();
  renderInMeeting();
  localStorage.setItem('arlo-vertical', 'notes');
  await screen.findByText('Transcription not started');
  await waitFor(() => expect(FakeWebSocket.last?.readyState).toBe(FakeWebSocket.OPEN));

  await userEvent.click(screen.getByRole('button', { name: /back/i }));

  await waitFor(() => expect(window.location.hash).toBe('#/home'));
  expect(window.location.hash).not.toContain('select-vertical');
  expect(screen.queryByText('Welcome to Arlo')).not.toBeInTheDocument();
  expect(localStorage.getItem('arlo-vertical')).toBe('notes');
});
