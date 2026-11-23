import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage, serverMessagesFor,
  arloPath, ARLO_ABSENT, MEETING,
} from '../test/harness';

// The panel is bound to the meeting it is in now. An access check that was
// started for the previous meeting and answers after the panel moved on binds
// nothing: no verified id, no socket, no fetch. Driven through the real app.

const MEETING_2 = 'MEETING-2==';
const byZoomId = (meetingId) => `/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}`;
const NOTES = {
  summary: 'Notes of the first meeting.',
  decisions: ['Decided in the first meeting'],
  actionItems: [],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 9,
};
const OWNER = { present: true, role: 'owner', ownerName: 'Ana' };
const fromSecond = serverMessagesFor(MEETING_2);

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const socketOpen = () => waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
const urlsOf = (fetchMock) => fetchMock.mock.calls.map(([url]) => String(url));
const socketsFor = (meetingId) => FakeWebSocket.instances
  .filter((socket) => socket.url.endsWith(`meeting_id=${encodeURIComponent(meetingId)}`));
const subscriptions = () => FakeWebSocket.instances
  .flatMap((socket) => socket.sent)
  .filter((message) => message.type === 'subscribe')
  .map((message) => message.payload.meetingId);

const leaveMeeting = (sdk) => act(async () => {
  sdk.emit('onRunningContextChange', { runningContext: 'inMainClient' });
});
const joinMeeting = (sdk, meetingUUID) => act(async () => {
  sdk.getMeetingUUID.mockResolvedValue({ meetingUUID });
  sdk.emit('onRunningContextChange', { runningContext: 'inMeeting' });
});

/**
 * The app with an access route the test answers by hand: `answers[n]` settles
 * the n-th check. Everything of the first meeting is there to be fetched, so
 * a panel wrongly bound to it would show it.
 */
function openWithHeldAccessChecks() {
  const answers = [];
  const fetchMock = mockFetch({
    '/api/auth/meeting-access': () => new Promise((resolve) => {
      answers.push((meetingId) => resolve(json({ verified: true, isGuest: false, meetingId })));
    }),
    [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...OWNER }),
    [arloPath('notes')]: () => json({ notes: NOTES }),
    [`${byZoomId(MEETING)}/transcript`]: () => json({
      segments: [serverMessage.segment(1, 'Said in the first meeting.').data.segment],
    }),
    [arloPath('state', MEETING_2)]: () => json({ ...ARLO_ABSENT }),
    [arloPath('notes', MEETING_2)]: () => json({ notes: null }),
  });
  const result = renderInMeeting();
  return { ...result, fetchMock, answers };
}

afterEach(() => { resetHarness(); localStorage.clear(); });

describe('an access check that answers after the panel moved to another meeting', () => {
  test('binds nothing to the first meeting, and the panel verifies and connects for the second', async () => {
    const { sdk, fetchMock, answers } = openWithHeldAccessChecks();
    await waitFor(() => expect(answers).toHaveLength(1));

    // The user is in another meeting before the first check answered
    await joinMeeting(sdk, MEETING_2);
    await waitFor(() => expect(window.location.hash).toBe(`#/meeting/${encodeURIComponent(MEETING_2)}`));
    expect(answers).toHaveLength(1); // the connect for the second meeting waits behind the first check

    await act(async () => { answers[0](MEETING); });
    // The late answer is dropped, and a check for the meeting the panel is in now starts
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(FakeWebSocket.instances).toHaveLength(0);
    await act(async () => { answers[1](MEETING_2); });
    await socketOpen();

    expect(socketsFor(MEETING)).toHaveLength(0);
    expect(socketsFor(MEETING_2)).toHaveLength(1);
    expect(subscriptions()).toEqual([MEETING_2]);
    await waitFor(() => expect(urlsOf(fetchMock)).toContain(arloPath('state', MEETING_2)));
    expect(await screen.findByRole('heading', { name: 'Bring Arlo into this meeting' })).toBeInTheDocument();

    // Nothing was asked of the server about the first meeting, and nothing of it shows
    expect(urlsOf(fetchMock).filter((url) => url.startsWith(byZoomId(MEETING)))).toEqual([]);
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.queryByText('Arlo is in the meeting')).not.toBeInTheDocument();
    await act(async () => { window.location.hash = `#/meeting/${encodeURIComponent(MEETING_2)}/record`; });
    expect(await screen.findByText('Nothing has been said since Arlo joined.')).toBeInTheDocument();
    expect(screen.queryByText('Said in the first meeting.')).not.toBeInTheDocument();

    // The second meeting is live on this panel
    await send(fromSecond.segment(1, 'Said in the second meeting.'));
    expect(await screen.findByText('Said in the second meeting.')).toBeInTheDocument();
    await send(serverMessage.segment(2, 'Said in the first meeting, later.'));
    expect(screen.queryByText('Said in the first meeting, later.')).not.toBeInTheDocument();
  });

  test('the same when the user left the first meeting and nothing else was joined: no socket, no fetch', async () => {
    const { sdk, fetchMock, answers } = openWithHeldAccessChecks();
    await waitFor(() => expect(answers).toHaveLength(1));
    await leaveMeeting(sdk);
    await act(async () => { answers[0](MEETING); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(answers).toHaveLength(1);
    expect(urlsOf(fetchMock).filter((url) => url.startsWith(byZoomId(MEETING)))).toEqual([]);
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();

    // Joining a meeting afterwards starts from nothing
    await joinMeeting(sdk, MEETING_2);
    await userEvent.click(await screen.findByRole('link', { name: 'Back to the meeting' }));
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => { answers[1](MEETING_2); });
    await socketOpen();
    expect(subscriptions()).toEqual([MEETING_2]);
    expect(urlsOf(fetchMock).filter((url) => url.startsWith(byZoomId(MEETING)))).toEqual([]);
  });
});

describe('moving straight from a verified meeting into another', () => {
  test('nothing more is asked or sent under the first meeting\'s id, from the moment the meeting changes', async () => {
    const { sdk, fetchMock, answers } = openWithHeldAccessChecks();
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => { answers[0](MEETING); });
    await socketOpen();
    await send(serverMessage.status('rtms_started'));
    await screen.findByText(NOTES.summary);
    // The topic of the running meeting was sent for the first meeting
    await waitFor(() => expect(urlsOf(fetchMock)).toContain(`${byZoomId(MEETING)}/topic`));
    const aboutFirst = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(byZoomId(MEETING))).length;
    const before = aboutFirst();

    await joinMeeting(sdk, MEETING_2);
    await waitFor(() => expect(answers).toHaveLength(2));
    // The second meeting is not verified yet: the first one's id is already not used
    expect(aboutFirst()).toBe(before);
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();

    await act(async () => { answers[1](MEETING_2); });
    await waitFor(() => expect(socketsFor(MEETING_2)).toHaveLength(1));
    await socketOpen();
    await waitFor(() => expect(urlsOf(fetchMock)).toContain(arloPath('state', MEETING_2)));
    expect(aboutFirst()).toBe(before);
    expect(subscriptions()).toEqual([MEETING, MEETING_2]);
  });
});

describe('one meeting, as before', () => {
  test('one access check, one socket, and the first meeting\'s state, notes and transcript', async () => {
    const { fetchMock, answers } = openWithHeldAccessChecks();
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => { answers[0](MEETING); });
    await socketOpen();
    await send(serverMessage.status('rtms_started'));

    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    expect(answers).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(subscriptions()).toEqual([MEETING]);
    expect(urlsOf(fetchMock)).toContain(`${byZoomId(MEETING)}/transcript`);
  });

  test('a dropped socket is verified again and reconnected for the same meeting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { answers } = openWithHeldAccessChecks();
      await waitFor(() => expect(answers).toHaveLength(1));
      await act(async () => { answers[0](MEETING); });
      await socketOpen();
      await send(serverMessage.status('rtms_started'));
      await screen.findByText(NOTES.summary);

      await act(async () => { server().close(1006); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
      await waitFor(() => expect(answers).toHaveLength(2));
      await act(async () => { answers[1](MEETING); });
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      await socketOpen();

      expect(subscriptions()).toEqual([MEETING, MEETING]);
      expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Resume, for a pause only the server knows about', () => {
  const statusPosts = (fetchMock) => fetchMock.mock.calls
    .filter(([url, init]) => String(url) === '/api/rtms/status' && init?.method === 'POST');

  async function openAsOwner() {
    const fetchMock = mockFetch({ [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...OWNER }) });
    const result = renderInMeeting();
    await socketOpen();
    await send(serverMessage.status('rtms_started'));
    await screen.findByText('Arlo is in the meeting');
    return { ...result, fetchMock };
  }

  test('the resume is reported to the server once Zoom accepted it, though this panel never saw the pause', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    // Two owners paused, the other one resumed: the meeting runs, this owner's stream is paused
    await send(serverMessage.arloState({ ...OWNER, paused: false, myStreamPaused: true }));
    expect(await screen.findByText('Arlo is paused')).toBeInTheDocument();
    expect(statusPosts(fetchMock)).toHaveLength(0);

    let accept;
    sdk.resumeRTMS.mockImplementation(() => new Promise((resolve) => { accept = () => resolve({ message: 'Success' }); }));
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(sdk.resumeRTMS).toHaveBeenCalledTimes(1);
    expect(statusPosts(fetchMock)).toHaveLength(0); // not before Zoom answered

    await act(async () => { accept(); });
    await waitFor(() => expect(statusPosts(fetchMock)).toHaveLength(1));
    const [, init] = statusPosts(fetchMock)[0];
    expect(JSON.parse(init.body)).toEqual({ meetingId: MEETING, status: 'rtms_resumed' });
    expect(init.credentials).toBe('include');

    // The server then says the stream runs: the panel is back on the live notes
    await send(serverMessage.arloState({ ...OWNER, paused: false, myStreamPaused: false }));
    expect(await screen.findByText('Arlo is in the meeting')).toBeInTheDocument();
    expect(statusPosts(fetchMock)).toHaveLength(1);
  });

  test('nothing is reported when Zoom refuses the resume', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.arloState({ ...OWNER, paused: false, myStreamPaused: true }));
    await screen.findByText('Arlo is paused');
    sdk.resumeRTMS.mockRejectedValue(Object.assign(new Error('Not allowed'), { code: '10000' }));
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sdk.resumeRTMS).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(statusPosts(fetchMock)).toHaveLength(0);
  });

  test('a pause this panel saw is reported once on resume, as before', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.status('rtms_paused'));
    await send(serverMessage.arloState({ ...OWNER, paused: true, myStreamPaused: true }));
    await screen.findByText('Arlo is paused');
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(sdk.resumeRTMS).toHaveBeenCalledTimes(1);
    await send(serverMessage.status('rtms_resumed'));
    await waitFor(() => expect(statusPosts(fetchMock)).toHaveLength(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(statusPosts(fetchMock)).toHaveLength(1);
    expect(JSON.parse(statusPosts(fetchMock)[0][1].body)).toEqual({ meetingId: MEETING, status: 'rtms_resumed' });
  });
});
