import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createZoomSdk, FakeWebSocket, mockFetch, renderClassic as renderInMeeting, resetHarness, serverMessage,
} from '../test/harness';

// Zoom's Dynamic Indicator: Arlo's status in Zoom's own meeting window.

const server = () => FakeWebSocket.last;
const send = (message) => act(() => { server().serverSend(message); });
const lastText = (sdk) => sdk.setDynamicIndicator.mock.calls.at(-1)?.[0]?.text;

async function openMeeting(options) {
  mockFetch();
  const result = renderInMeeting(options);
  await screen.findByText('Transcription not started');
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  return result;
}

async function startHere(options) {
  const result = await openMeeting(options);
  await userEvent.click(await screen.findByRole('button', { name: 'Start Transcription' }));
  return result;
}

afterEach(resetHarness);

describe('dynamic indicator', () => {
  test('a request is not shown; the confirmed stream is', async () => {
    const { sdk } = await startHere();
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();

    await send(serverMessage.status('rtms_started'));
    await waitFor(() => expect(sdk.setDynamicIndicator).toHaveBeenCalledTimes(1));
    expect(lastText(sdk)).toMatch(/^Arlo is transcribing/);
    expect(sdk.setDynamicIndicator.mock.calls[0][0]).toEqual({ text: lastText(sdk) });
  });

  test('is removed when the stream stops, and while it is reconnecting', async () => {
    const { sdk } = await startHere();
    await send(serverMessage.status('rtms_started'));
    await waitFor(() => expect(sdk.setDynamicIndicator).toHaveBeenCalledTimes(1));

    await send(serverMessage.status('rtms_interrupted'));
    await waitFor(() => expect(sdk.removeDynamicIndicator).toHaveBeenCalledTimes(1));
    await send(serverMessage.status('rtms_started'));
    await waitFor(() => expect(sdk.setDynamicIndicator).toHaveBeenCalledTimes(2));

    await send(serverMessage.status('rtms_stopped'));
    await waitFor(() => expect(sdk.removeDynamicIndicator).toHaveBeenCalledTimes(2));
  });

  test('a panel that did not start the stream leaves the indicator alone', async () => {
    const { sdk } = await openMeeting();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Started elsewhere.'));
    expect(await screen.findByText('Started elsewhere.')).toBeInTheDocument();
    await send(serverMessage.status('rtms_stopped'));

    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
    expect(sdk.removeDynamicIndicator).not.toHaveBeenCalled();
  });

  test('a Zoom client without the API is left alone, and transcription still works', async () => {
    const sdk = createZoomSdk();
    delete sdk.setDynamicIndicator;
    delete sdk.removeDynamicIndicator;
    await startHere({ sdk });
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Still transcribing.'));
    expect(await screen.findByText('Still transcribing.')).toBeInTheDocument();
  });

  test('a refusal from Zoom is not shown to the user', async () => {
    const sdk = createZoomSdk();
    sdk.setDynamicIndicator.mockRejectedValue(Object.assign(new Error('No Permission for this API'), { code: '10012' }));
    await startHere({ sdk });
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Works without the indicator.'));

    expect(await screen.findByText('Works without the indicator.')).toBeInTheDocument();
    expect(screen.queryByText(/No Permission/)).not.toBeInTheDocument();
    expect(sdk.showNotification).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Permission/) }));
  });
});
