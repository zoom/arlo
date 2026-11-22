import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
} from '../test/harness';

// The meeting title (rename, AI suggestion) and the share menu.

const server = () => FakeWebSocket.last;
const send = (message) => act(() => { server().serverSend(message); });

async function liveMeeting(routes) {
  const fetchMock = mockFetch(routes);
  const result = renderInMeeting();
  await screen.findByText('Transcription not started');
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.segment(1, 'We need to settle the launch date for the importer today.'));
  await send(serverMessage.segment(2, 'Friday works if design signs off.', { speakerLabel: 'Ben', speakerId: '2' }));
  await screen.findByText('Transcribing');
  return { fetchMock, ...result };
}

afterEach(resetHarness);

describe('meeting title', () => {
  test('shows the Zoom topic', async () => {
    await liveMeeting();
    expect(screen.getByRole('heading', { name: 'Planning' })).toBeInTheDocument();
  });

  test('AI suggests a title from the live transcript, with speaker names, and the user confirms it', async () => {
    let sent;
    const { fetchMock } = await liveMeeting({
      'POST /api/ai/title-live': ({ body }) => { sent = body; return json({ title: 'Importer Launch Date' }); },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Suggest a title with AI' }));

    const input = await screen.findByRole('textbox', { name: 'Meeting title' });
    expect(input).toHaveValue('Importer Launch Date');
    expect(sent.transcript).toContain('Ana: We need to settle the launch date');
    expect(sent.transcript).toContain('Ben: Friday works');
    expect(sent.currentTitle).toBe('Planning');

    await userEvent.click(screen.getByRole('button', { name: 'Save title' }));
    expect(await screen.findByRole('heading', { name: 'Importer Launch Date' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/topic'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  test('an AI failure says why and leaves the title alone (it used to crash on save)', async () => {
    await liveMeeting({
      'POST /api/ai/title-live': () => json({ error: 'The free AI models are rate limited right now. Try again in a minute.' }, 429),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Suggest a title with AI' }));

    expect(await screen.findByText('The free AI models are rate limited right now. Try again in a minute.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Meeting title' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Planning' })).toBeInTheDocument();
  });

  test('a response without a title does not open the editor', async () => {
    await liveMeeting({ 'POST /api/ai/title-live': () => json({ demoMode: true, available: false }) });
    await userEvent.click(screen.getByRole('button', { name: 'Suggest a title with AI' }));
    expect(await screen.findByText('Failed to generate title')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Meeting title' })).not.toBeInTheDocument();
  });
});

describe('share menu', () => {
  test('is offered while transcription runs and invites everyone', async () => {
    const { sdk } = await liveMeeting();
    await userEvent.click(screen.getByRole('button', { name: 'Share Arlo with participants' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Invite all participants' }));

    expect(sdk.sendAppInvitationToAllParticipants).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Invitation sent to all participants')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('offers collaborate mode to a signed-in user', async () => {
    const { sdk } = await liveMeeting();
    await userEvent.click(screen.getByRole('button', { name: 'Share Arlo with participants' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Start collaborate mode' }));
    expect(sdk.startCollaborate).toHaveBeenCalledWith({ shareScreen: false });
  });
});
