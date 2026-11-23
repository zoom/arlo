import { screen, waitFor, act } from '@testing-library/react';
import {
  FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage, MEETING,
} from '../test/harness';

// A panel that opens late, or loses its connection, catches up from the server.

const server = () => FakeWebSocket.last;
const send = (message) => act(() => { server().serverSend(message); });
const stored = (seqNo, text) => ({
  seqNo, text, speakerId: '1', speakerLabel: 'Ana', tStartMs: 1000 * seqNo, tEndMs: 1000 * seqNo,
});
const transcriptPath = `/api/meetings/by-zoom-id/${encodeURIComponent(MEETING)}/transcript`;

afterEach(resetHarness);

test('opening the panel late shows what was said before', async () => {
  mockFetch({ [transcriptPath]: () => json({ segments: [stored(1, 'Said before I opened Arlo.')] }) });
  renderInMeeting();
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));

  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.segment(2, 'Said while I was watching.'));

  expect(await screen.findByText('Said before I opened Arlo.')).toBeInTheDocument();
  expect(screen.getByText('Said while I was watching.')).toBeInTheDocument();
});

test('after the connection drops and returns, the missed lines are fetched', async () => {
  let segments = [stored(1, 'First line.')];
  const fetchMock = mockFetch({ [transcriptPath]: () => json({ segments }) });
  renderInMeeting();
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.status('rtms_started'));
  expect(await screen.findByText('First line.')).toBeInTheDocument();

  const first = server();
  segments = [stored(1, 'First line.'), stored(2, 'Said while I was disconnected.')];
  await act(async () => { first.close(1006); });

  // The panel reconnects by itself after 5 seconds
  await waitFor(() => {
    expect(server()).not.toBe(first);
    expect(server().readyState).toBe(FakeWebSocket.OPEN);
  }, { timeout: 8000 });
  await send(serverMessage.status('rtms_started'));

  expect(await screen.findByText('Said while I was disconnected.')).toBeInTheDocument();
  expect(screen.getAllByText('First line.')).toHaveLength(1);
  const transcriptCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(transcriptPath));
  expect(transcriptCalls.length).toBeGreaterThanOrEqual(2);
}, 15000);
