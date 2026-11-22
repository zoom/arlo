import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createZoomSdk, FakeWebSocket, mockFetch, renderInMeeting, resetHarness, serverMessage,
} from '../test/harness';

// UI state tests: the real app inside a fake Zoom meeting. They stand in for
// checking each state by hand in a live meeting.

const server = () => FakeWebSocket.last;
const send = (message) => act(() => { server().serverSend(message); });
const startButton = () => screen.findByRole('button', { name: 'Start Transcription' });

async function openMeeting(options) {
  mockFetch();
  const result = renderInMeeting(options);
  await screen.findByText('Transcription not started');
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  return result;
}

afterEach(resetHarness);

describe('starting transcription', () => {
  test('a click on Start is a request, not a running transcription', async () => {
    const { sdk } = await openMeeting();
    await userEvent.click(await startButton());

    expect(await screen.findAllByText('Requesting transcription…')).not.toHaveLength(0);
    expect(sdk.callZoomApi).toHaveBeenCalledWith('startRTMS', expect.any(Object));
    expect(screen.queryByText('Waiting for transcript...')).not.toBeInTheDocument();
    expect(sdk.showNotification).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Transcription started' }));
  });

  test('the server confirming the stream shows "Waiting for transcript", then the words', async () => {
    const { sdk } = await openMeeting();
    await userEvent.click(await startButton());
    await send(serverMessage.status('rtms_started'));

    expect(await screen.findAllByText('Waiting for transcript...')).not.toHaveLength(0);
    expect(sdk.showNotification).toHaveBeenCalledWith(expect.objectContaining({ message: 'Transcription started' }));

    await send(serverMessage.segment(1, 'We ship on Friday.'));
    expect(await screen.findByText('We ship on Friday.')).toBeInTheDocument();
    expect(screen.getAllByText('Transcribing').length).toBeGreaterThan(0);
  });

  test('a host denial shows the reason and gives Start back', async () => {
    await openMeeting();
    await userEvent.click(await startButton());
    await send(serverMessage.requestStatus(3));

    expect(await screen.findAllByText('The host declined the transcription request.')).not.toHaveLength(0);
    expect(await startButton()).toBeEnabled();
  });

  test('a start error from Zoom is shown, not swallowed', async () => {
    const sdk = createZoomSdk({
      startRTMS: async () => { throw Object.assign(new Error('RTMS is not enabled for this app'), { code: '10301' }); },
    });
    await openMeeting({ sdk });
    await userEvent.click(await startButton());

    expect(await screen.findAllByText('RTMS is not enabled for this app')).not.toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  test('a stream Arlo could not join is reported, with Start available', async () => {
    await openMeeting();
    await userEvent.click(await startButton());
    await send(serverMessage.status('rtms_failed'));

    expect(await screen.findAllByText('Arlo could not connect to the transcription stream. Start again.')).not.toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  test('a stream started elsewhere (Zoom\'s own Start button) goes live without a click here', async () => {
    await openMeeting();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Hello from the notifier start.'));

    expect(await screen.findByText('Hello from the notifier start.')).toBeInTheDocument();
  });
});

describe('transcript', () => {
  test('speech after Stop → Start is kept, although sequence numbers restart', async () => {
    await openMeeting();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Before the break.'));
    await send(serverMessage.status('rtms_stopped'));
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'After the break.', { tStartMs: 900000 }));

    expect(await screen.findByText('After the break.')).toBeInTheDocument();
    expect(screen.getByText('Before the break.')).toBeInTheDocument();
  });

  test('the transcript survives leaving the meeting screen and coming back', async () => {
    await openMeeting();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Said before navigating.'));
    expect(await screen.findByText('Said before navigating.')).toBeInTheDocument();

    await act(async () => { window.location.hash = '#/settings'; });
    await waitFor(() => expect(screen.queryByText('Said before navigating.')).not.toBeInTheDocument());
    await send(serverMessage.segment(2, 'Said while away.'));

    await act(async () => { window.location.hash = `#/meeting/${encodeURIComponent('MEETING-1==')}`; });
    expect(await screen.findByText('Said before navigating.')).toBeInTheDocument();
    expect(screen.getByText('Said while away.')).toBeInTheDocument();
  });
});

describe('auto-start', () => {
  const startCalls = (sdk) => sdk.callZoomApi.mock.calls.filter(([name]) => name === 'startRTMS');

  test('with auto-start on, opening the panel requests transcription once', async () => {
    const { sdk } = await openMeeting({ autoStart: true });
    await waitFor(() => expect(startCalls(sdk)).toHaveLength(1));
  });

  test('with auto-start off, nothing is requested until the user clicks Start', async () => {
    const { sdk } = await openMeeting({ autoStart: false });
    await new Promise((resolve) => setTimeout(resolve, 900)); // past the 500ms auto-start delay
    expect(startCalls(sdk)).toHaveLength(0);
    expect(await startButton()).toBeEnabled();
  });
});
