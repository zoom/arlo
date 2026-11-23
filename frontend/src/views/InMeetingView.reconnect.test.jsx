import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FakeWebSocket, mockFetch, renderClassic as renderInMeeting, resetHarness, serverMessage,
} from '../test/harness';

// UI state tests for a stream that drops: reconnecting, back again, or ended
// by Zoom because of a connection problem (then restarted).

const FAULT_MESSAGE = 'Transcription stopped because of a connection problem.';
const server = () => FakeWebSocket.last;
const send = (message) => act(() => { server().serverSend(message); });
const startCalls = (sdk) => sdk.callZoomApi.mock.calls.filter(([name]) => name === 'startRTMS').length;
const pause = (ms) => act(() => new Promise((resolve) => { setTimeout(resolve, ms); }));

async function openMeeting(options) {
  mockFetch();
  const result = renderInMeeting(options);
  await screen.findByText('Transcription not started');
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  return result;
}

/** A stream this panel started and that is producing text. */
async function startedHere() {
  const result = await openMeeting();
  await userEvent.click(await screen.findByRole('button', { name: 'Start Transcription' }));
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.segment(1, 'Before the drop.'));
  expect(startCalls(result.sdk)).toBe(1);
  return result;
}

afterEach(resetHarness);

describe('a stream that drops', () => {
  test('shows "Reconnecting…" and returns to transcribing when the server rejoins it', async () => {
    await startedHere();
    await send(serverMessage.status('rtms_interrupted'));
    expect(await screen.findAllByText('Reconnecting…')).not.toHaveLength(0);

    await send(serverMessage.status('rtms_started')); // what a rejoin looks like to the panel
    await waitFor(() => expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument());
    expect(screen.getAllByText('Transcribing').length).toBeGreaterThan(0);
    expect(screen.getByText('Before the drop.')).toBeInTheDocument();
  });

  test('ended by a fault, started elsewhere: says why and offers Restart, without restarting by itself', async () => {
    const { sdk } = await openMeeting();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Started by someone else.'));
    await send(serverMessage.status('rtms_stopped', { fault: true }));

    expect(await screen.findAllByText(FAULT_MESSAGE)).not.toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'Restart Transcription' })).toBeEnabled();
    await pause(2500);
    expect(startCalls(sdk)).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'Restart Transcription' }));
    expect(startCalls(sdk)).toBe(1);
  });

  test('ended by a fault, started here: asks Zoom for a new stream once, without a click', async () => {
    const { sdk } = await startedHere();
    await send(serverMessage.status('rtms_stopped', { fault: true }));
    expect(await screen.findAllByText(FAULT_MESSAGE)).not.toHaveLength(0);

    await waitFor(() => expect(startCalls(sdk)).toBe(2), { timeout: 4000 });
    expect(await screen.findAllByText('Requesting transcription…')).not.toHaveLength(0);

    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'After the restart.', { tStartMs: 900000 }));
    expect(await screen.findByText('After the restart.')).toBeInTheDocument();
    expect(screen.getByText('Before the drop.')).toBeInTheDocument();
    await pause(2500);
    expect(startCalls(sdk)).toBe(2);
  });

  test('the Zoom client reporting the stop first does not lose the restart', async () => {
    const { sdk } = await startedHere();
    await act(() => { sdk.emit('onRTMSStatusChange', { status: 'stopped' }); });
    await send(serverMessage.status('rtms_stopped', { fault: true }));

    expect(await screen.findAllByText(FAULT_MESSAGE)).not.toHaveLength(0);
    await waitFor(() => expect(startCalls(sdk)).toBe(2), { timeout: 4000 });
  });

  test('a failed automatic restart leaves the reason and a button', async () => {
    const { sdk } = await startedHere();
    sdk.startRTMS.mockImplementation(async () => {
      throw Object.assign(new Error('Zoom could not start the stream'), { code: '10000' });
    });
    await send(serverMessage.status('rtms_stopped', { fault: true }));

    await waitFor(() => expect(startCalls(sdk)).toBe(2), { timeout: 4000 });
    expect(await screen.findAllByText('Zoom could not start the stream')).not.toHaveLength(0);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeEnabled();
    await pause(2500);
    expect(startCalls(sdk)).toBe(2);
  });

  test('a stream the user stopped here is not restarted', async () => {
    const { sdk } = await startedHere();
    await userEvent.click(await screen.findByRole('button', { name: /stop/i }));
    await send(serverMessage.status('rtms_stopped'));
    await send(serverMessage.status('rtms_stopped', { fault: true })); // a late, contradictory report
    await pause(2500);
    expect(startCalls(sdk)).toBe(1);
  });

  test('an ordinary stop shows no connection problem', async () => {
    const { sdk } = await startedHere();
    await send(serverMessage.status('rtms_stopped'));
    expect(await screen.findByRole('button', { name: 'Start Transcription' })).toBeEnabled();
    expect(screen.queryByText(FAULT_MESSAGE)).not.toBeInTheDocument();
    await pause(2500);
    expect(startCalls(sdk)).toBe(1);
  });
});
