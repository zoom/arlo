import { screen, waitFor, act } from '@testing-library/react';
import {
  FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
} from '../test/harness';

// Voice commands: someone says "Hey Arlo, ..." and the transcript line triggers it.

const server = () => FakeWebSocket.last;
const send = (message) => act(() => { server().serverSend(message); });

async function liveMeeting(routes) {
  const fetchMock = mockFetch(routes);
  const result = renderInMeeting();
  await screen.findByText('Transcription not started');
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.segment(1, 'The launch moves to Friday because design needs two more days.'));
  await screen.findByText('Transcribing');
  return { fetchMock, ...result };
}
const calls = (fetchMock, path) => fetchMock.mock.calls.filter(([url]) => String(url).includes(path));

afterEach(resetHarness);

test('a spoken question is answered from the live transcript', async () => {
  let sent;
  await liveMeeting({
    'POST /api/ai/ask-live': ({ body }) => { sent = body; return json({ answer: 'The launch is on Friday.' }); },
  });
  await send(serverMessage.segment(2, 'Hey Arlo, when is the launch?', { tStartMs: 9000 }));

  expect(await screen.findByText('The launch is on Friday.')).toBeInTheDocument();
  expect(sent.question).toBe('When is the launch?');
  expect(sent.transcript).toContain('Ana: The launch moves to Friday');
});

test('"summarize" asks for a summary of the live transcript', async () => {
  let sent;
  await liveMeeting({
    'POST /api/ai/summary-live': ({ body }) => {
      sent = body;
      return json({ summary: { overview: 'Launch moved to Friday.', keyPoints: ['Design needs two more days'] } });
    },
  });
  await send(serverMessage.segment(2, 'Hey Arlo, summarize this meeting', { tStartMs: 9000 }));

  await waitFor(() => expect(sent?.transcript).toContain('The launch moves to Friday'));
  expect(await screen.findByText(/Launch moved to Friday\./)).toBeInTheDocument();
});

test('a name that only contains "arlo" runs nothing', async () => {
  const { fetchMock } = await liveMeeting();
  await send(serverMessage.segment(2, 'Carlos, can you summarize the tasks?', { tStartMs: 9000 }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(calls(fetchMock, '/api/ai/')).toHaveLength(0);
});

test('a highlight that demo mode did not save is not reported as created', async () => {
  await liveMeeting({
    // what the demo-mode backend answers: 200, no highlight
    'POST /api/highlights': () => json({ highlight: null, demoMode: true }),
  });
  await send(serverMessage.segment(2, 'Hey Arlo, highlight', { tStartMs: 9000 }));

  expect(await screen.findByText('Highlights are not saved in demo mode')).toBeInTheDocument();
  expect(screen.queryByText('Highlight created!')).not.toBeInTheDocument();
  expect(screen.queryByText('Highlight created at current timestamp!')).not.toBeInTheDocument();
});
