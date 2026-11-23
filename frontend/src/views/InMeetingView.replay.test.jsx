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

test('history is loaded again when the server confirms the subscription, closing the gap before live lines', async () => {
  let segments = [stored(1, 'First line.')];
  const fetchMock = mockFetch({ [transcriptPath]: () => json({ segments }) });
  renderInMeeting();
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  const callsBefore = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(transcriptPath)).length;

  // A line is stored after the first load but before this socket is subscribed
  segments = [stored(1, 'First line.'), stored(2, 'Said in the gap.')];
  await send({ type: 'subscribed', data: { meetingId: MEETING } });
  await send(serverMessage.status('rtms_started'));

  expect(await screen.findByText('Said in the gap.')).toBeInTheDocument();
  const callsAfter = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(transcriptPath)).length;
  expect(callsAfter).toBe(callsBefore + 1);
});

test('a timeline event that arrives both in history and live is shown once', async () => {
  const eventsPath = `/api/meetings/by-zoom-id/${encodeURIComponent(MEETING)}/participant-events`;
  const joined = { id: 'event-1', eventType: 'joined', participantName: 'Bo', participantId: '12', timestamp: Date.now() };
  mockFetch({
    [transcriptPath]: () => json({ segments: [stored(1, 'Hello.')] }),
    [eventsPath]: () => json({ events: [joined] }),
  });
  renderInMeeting();
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.status('rtms_started'));
  expect(await screen.findByText('Hello.')).toBeInTheDocument();

  const before = screen.queryAllByText(/Bo/).length;
  expect(before).toBeGreaterThan(0);
  await send({ type: 'participant.event', data: { meetingId: MEETING, event: joined } });
  await send({ type: 'participant.event', data: { meetingId: MEETING, event: joined } });
  expect(screen.queryAllByText(/Bo/)).toHaveLength(before);
});

test('when the access check gets no answer after a drop, the panel keeps trying and comes back by itself', async () => {
  let networkDown = false;
  mockFetch({
    [transcriptPath]: () => json({ segments: [] }),
    '/api/auth/meeting-access': () => {
      if (networkDown) throw new TypeError('Failed to fetch');
      return json({ verified: true, isGuest: false, meetingId: MEETING });
    },
  });
  renderInMeeting();
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  const first = server();

  networkDown = true;
  await act(async () => { first.close(1006); });
  await act(() => new Promise((resolve) => { setTimeout(resolve, 6000); })); // first retry fails
  expect(server()).toBe(first);

  networkDown = false;
  await waitFor(() => {
    expect(server()).not.toBe(first);
    expect(server().readyState).toBe(FakeWebSocket.OPEN);
  }, { timeout: 8000 });
}, 25000);

test('a gateway error on the access check is retried; a refusal is not', async () => {
  let answer = () => json({ verified: true, isGuest: false, meetingId: MEETING });
  const fetchMock = mockFetch({
    [transcriptPath]: () => json({ segments: [] }),
    '/api/auth/meeting-access': () => answer(),
  });
  const accessCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/auth/meeting-access')).length;
  renderInMeeting();
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));

  // 502 while the backend restarts, then healthy: the panel comes back by itself
  const first = server();
  let bad = true;
  answer = () => (bad ? json({ error: 'Bad gateway' }, 502) : json({ verified: true, isGuest: false, meetingId: MEETING }));
  await act(async () => { first.close(1006); });
  await act(() => new Promise((resolve) => { setTimeout(resolve, 5500); }));
  expect(server()).toBe(first);
  bad = false;
  await waitFor(() => {
    expect(server()).not.toBe(first);
    expect(server().readyState).toBe(FakeWebSocket.OPEN);
  }, { timeout: 8000 });

  // a refusal is final until the user retries
  const second = server();
  answer = () => json({ error: 'Not in this meeting' }, 403);
  await act(async () => { second.close(1006); });
  await act(() => new Promise((resolve) => { setTimeout(resolve, 5500); }));
  const afterRefusal = accessCalls();
  await act(() => new Promise((resolve) => { setTimeout(resolve, 6000); }));
  expect(accessCalls()).toBe(afterRefusal);
  expect(server()).toBe(second);

}, 40000);
