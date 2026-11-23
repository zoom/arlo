import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, renderClassic, resetHarness, serverMessage,
  arloPath, ARLO_ABSENT, MEETING,
} from '../test/harness';

// Where one meeting stops and the next begins: messages for another meeting
// are ignored, the owner's notes outlive the meeting in the open panel, and
// nothing of one meeting shows in the next. Driven through the real app.

const ID = encodeURIComponent(MEETING);
const OTHER = 'OTHER-MEETING==';
const MEETING_2 = 'MEETING-2==';
const ID_2 = encodeURIComponent(MEETING_2);
const NOTES = {
  summary: 'The beta moves to March 3 so billing can finish first.',
  decisions: ['Beta launch moves to March 3'],
  actionItems: [{ text: 'Send the revised timeline', owner: 'Ana' }],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 9,
};
const OWNER = { present: true, role: 'owner', ownerName: 'Ana' };
const ANA_BROUGHT_ARLO = { present: true, role: 'participant', ownerName: 'Ana' };

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
/** The same message, as the server would send it about another meeting. */
const forMeeting = (message, meetingId) => ({ ...message, data: { ...message.data, meetingId } });
const socketOpen = () => waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
const meeting2Path = (name) => `/api/meetings/by-zoom-id/${ID_2}/${name}`;

async function openArlo({ sdk, routes = {}, state } = {}) {
  const fetchMock = mockFetch({
    ...(state && { [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }) }),
    ...routes,
  });
  const result = renderInMeeting({ sdk });
  await socketOpen();
  return { ...result, fetchMock };
}

/** The owner's panel with notes on screen and one line said. */
async function openAsOwnerWithNotes(options = {}) {
  const result = await openArlo({ state: OWNER, ...options });
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.segment(1, 'Said in the first meeting.'));
  await send(serverMessage.notes(NOTES));
  await screen.findByText(NOTES.summary);
  return result;
}

const leaveMeeting = (sdk) => act(async () => {
  sdk.emit('onRunningContextChange', { runningContext: 'inMainClient' });
});
const joinMeeting = (sdk, meetingUUID) => act(async () => {
  sdk.getMeetingUUID.mockResolvedValue({ meetingUUID });
  sdk.emit('onRunningContextChange', { runningContext: 'inMeeting' });
});

afterEach(() => { resetHarness(); localStorage.clear(); });

describe('messages for another meeting', () => {
  test('a stream started in another meeting does not bring Arlo into this one', async () => {
    await openArlo();
    await screen.findByRole('heading', { name: 'Bring Arlo into this meeting' });

    await send(forMeeting(serverMessage.status('rtms_started'), OTHER));
    await send(forMeeting(serverMessage.segment(1, 'Said in another meeting.'), OTHER));
    await send(forMeeting(serverMessage.requestStatus(3), OTHER));

    expect(screen.getByRole('heading', { name: 'Bring Arlo into this meeting' })).toBeInTheDocument();
    expect(screen.queryByText('Arlo is in this meeting')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // The same messages about this meeting still work
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState(OWNER));
    expect(await screen.findByText('Arlo is in the meeting')).toBeInTheDocument();
  });

  test('another meeting\'s lines, events and end never reach this meeting\'s record', async () => {
    await openAsOwnerWithNotes();
    await send(forMeeting(serverMessage.segment(2, 'Said in another meeting.'), OTHER));
    await send(forMeeting(serverMessage.timelineEvent({
      id: 'other-1', eventType: 'joined', participantName: 'Stranger', participantId: null, timestamp: Date.now(),
    }), OTHER));
    await send(forMeeting(serverMessage.status('rtms_stopped', { meetingEnded: true }), OTHER));

    // Still live: the other meeting ending is not this one ending
    expect(screen.getByText('Arlo is in the meeting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy notes' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Meeting record' }));
    expect(await screen.findByText('Said in the first meeting.')).toBeInTheDocument();
    expect(screen.queryByText('Said in another meeting.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Stranger/)).not.toBeInTheDocument();

    await send(serverMessage.segment(3, 'Said here, later.'));
    expect(await screen.findByText('Said here, later.')).toBeInTheDocument();
  });
});

describe('messages for another meeting, on the earlier screens', () => {
  test('the guest transcript screen: another meeting\'s stream stopping does not end this one', async () => {
    mockFetch({}, { signedIn: false });
    renderInMeeting({ guest: true });
    await socketOpen();
    await act(async () => { window.location.hash = `#/guest/${ID}`; });
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Said in this meeting.'));
    expect(await screen.findByText('Said in this meeting.')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();

    await send(forMeeting(serverMessage.status('rtms_stopped'), OTHER));
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('Install Arlo to access this anytime')).not.toBeInTheDocument();

    // This meeting's own stop still ends the live view
    await send(serverMessage.status('rtms_stopped'));
    expect(await screen.findByText('Install Arlo to access this anytime')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  test('the classic screen: another meeting\'s suggestion is not shown', async () => {
    mockFetch();
    renderClassic();
    await screen.findByText('Transcription not started');
    await socketOpen();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Said in this meeting.'));
    await screen.findByText('Said in this meeting.');

    await send(forMeeting(serverMessage.suggestion({ text: 'Suggested for another meeting.' }), OTHER));
    expect(screen.queryByText('Suggested for another meeting.')).not.toBeInTheDocument();

    await send(serverMessage.suggestion({ text: 'Suggested for this meeting.' }));
    expect(await screen.findByText('Suggested for this meeting.')).toBeInTheDocument();
    expect(screen.queryByText('Suggested for another meeting.')).not.toBeInTheDocument();
  });
});

describe('a second meeting after a first', () => {
  test('the owner of the first sees none of its notes or transcript in the second', async () => {
    const { sdk } = await openAsOwnerWithNotes({
      routes: { [meeting2Path('arlo/state')]: () => json({ ...ARLO_ABSENT }) },
    });
    await leaveMeeting(sdk);
    await screen.findByRole('button', { name: 'Copy notes' });

    await joinMeeting(sdk, MEETING_2);
    expect(await screen.findByRole('heading', { name: 'Bring Arlo into this meeting' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID_2}`);
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy notes' })).not.toBeInTheDocument();

    await act(async () => { window.location.hash = `#/meeting/${ID_2}/record`; });
    expect(await screen.findByText('Nothing has been said since Arlo joined.')).toBeInTheDocument();
    expect(screen.queryByText('Said in the first meeting.')).not.toBeInTheDocument();

    // Home no longer offers the first meeting's notes
    await act(async () => { window.location.hash = '#/home'; });
    await screen.findByRole('link', { name: 'Back to the meeting' });
    expect(screen.queryByRole('link', { name: 'Back to your notes' })).not.toBeInTheDocument();
  });

  test('a participant of the first sees no owner name or "ended" state from it in the second', async () => {
    const sdk = createZoomSdk({ role: 'attendee', screenName: 'Ben' });
    await openArlo({
      sdk,
      state: ANA_BROUGHT_ARLO,
      routes: { [meeting2Path('arlo/state')]: () => json({ ...ARLO_ABSENT }) },
    });
    await send(serverMessage.status('rtms_started'));
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    await act(async () => {
      server().serverSend(serverMessage.status('rtms_stopped', { meetingEnded: true }));
      server().serverSend(serverMessage.arloState({ present: false, role: 'participant', ownerName: null }));
    });
    await screen.findByText('Nothing is stored after the meeting ends.');

    await leaveMeeting(sdk);
    await waitFor(() => expect(window.location.hash).toBe('#/home'));
    await joinMeeting(sdk, MEETING_2);
    await userEvent.click(await screen.findByRole('link', { name: 'Back to the meeting' }));

    expect(await screen.findByRole('heading', { name: 'Arlo isn\'t in this meeting yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask the host to bring Arlo in' })).toBeInTheDocument();
    expect(screen.queryByText(/Ana/)).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing is stored after the meeting ends.')).not.toBeInTheDocument();
  });
});

describe('the owner leaves the meeting', () => {
  test('without the server ever saying it ended: the notes stay, as the after-meeting screen', async () => {
    const { sdk } = await openAsOwnerWithNotes();
    await leaveMeeting(sdk);

    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy notes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
  });

  test('after the server said it ended: the notes stay too', async () => {
    const { sdk } = await openAsOwnerWithNotes();
    await act(async () => {
      server().serverSend(serverMessage.status('rtms_stopped', { meetingEnded: true }));
      server().serverSend(serverMessage.arloState({ present: false, role: 'participant', ownerName: null }));
    });
    await screen.findByRole('button', { name: 'Copy notes' });
    await leaveMeeting(sdk);

    expect(screen.getByRole('heading', { name: 'Planning' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
  });

  test('a participant who leaves keeps nothing and goes home', async () => {
    const sdk = createZoomSdk({ role: 'attendee', screenName: 'Ben' });
    await openArlo({ sdk, state: ANA_BROUGHT_ARLO });
    await send(serverMessage.status('rtms_started'));
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    await leaveMeeting(sdk);

    await waitFor(() => expect(window.location.hash).toBe('#/home'));
    expect(screen.queryByRole('link', { name: 'Back to your notes' })).not.toBeInTheDocument();
  });
});

describe('after the meeting, the notes are one tap away from everywhere', () => {
  async function onAfterScreen() {
    const result = await openAsOwnerWithNotes();
    await leaveMeeting(result.sdk);
    await screen.findByRole('button', { name: 'Copy notes' });
    return result;
  }

  test('"Meeting record" shows what was said, and its Back link returns to the notes', async () => {
    await onAfterScreen();
    await userEvent.click(screen.getByRole('link', { name: 'Meeting record' }));

    expect(await screen.findByRole('heading', { name: 'Meeting record' })).toBeInTheDocument();
    expect(screen.getByText('Said in the first meeting.')).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}/record`);

    await userEvent.click(screen.getByRole('link', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: 'Copy notes' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
  });

  test('the header Back on the record returns to the notes', async () => {
    await onAfterScreen();
    await userEvent.click(screen.getByRole('link', { name: 'Meeting record' }));
    await screen.findByRole('heading', { name: 'Meeting record' });

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: 'Copy notes' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
  });

  test('the header Back from Settings returns to the notes', async () => {
    await onAfterScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings' });

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: 'Copy notes' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
  });

  test('Home has one link, "Back to your notes", that returns to them', async () => {
    await onAfterScreen();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(window.location.hash).toBe('#/home'));
    expect(screen.queryByRole('link', { name: 'Back to the meeting' })).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole('link', { name: 'Back to your notes' }));
    expect(await screen.findByRole('button', { name: 'Copy notes' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/meeting/${ID}`);
  });
});

describe('after the meeting, the session ends', () => {
  test('the notes are gone from every screen, a guest route included, and so is the way back to them', async () => {
    let sessionValid = true;
    const { sdk } = await openAsOwnerWithNotes({
      routes: {
        '/api/auth/me': () => (sessionValid
          ? json({ user: { id: 'user-1', displayName: 'Ana' } })
          : json({ error: 'Not authenticated' }, 401)),
        '/api/highlights': () => (sessionValid ? json({}) : json({ error: 'Unauthorized' }, 401)),
      },
    });
    await leaveMeeting(sdk);
    await screen.findByRole('button', { name: 'Copy notes' });

    // The session is lost (expiry, sign-out elsewhere, deauthorization): the next API call is refused
    sessionValid = false;
    await act(async () => { await fetch('/api/highlights', { credentials: 'include' }); });
    await waitFor(() => expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument());

    await act(async () => { window.location.hash = `#/guest-meeting/${ID}`; });
    await act(async () => {});
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy notes' })).not.toBeInTheDocument();

    await act(async () => { window.location.hash = `#/guest-meeting/${ID}/record`; });
    await act(async () => {});
    expect(screen.queryByText('Said in the first meeting.')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to your notes' })).not.toBeInTheDocument();
  });
});

describe('the socket reconnects', () => {
  const accessPath = '/api/auth/meeting-access';
  const accessCalls = (fetchMock) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(accessPath));

  test('re-verifying access keeps the screen: a typed question and a shown answer stay', async () => {
    let answerSecondCheck = null;
    let checks = 0;
    const { fetchMock } = await openAsOwnerWithNotes({
      routes: {
        [accessPath]: () => {
          checks += 1;
          if (checks === 1) return json({ verified: true, isGuest: false, meetingId: MEETING });
          return new Promise((resolve) => { answerSecondCheck = resolve; });
        },
        [`POST ${arloPath('ask')}`]: () => json({ answer: 'Ben will confirm the date.' }),
      },
    });
    const input = screen.getByRole('textbox', { name: 'Ask Arlo' });
    await userEvent.type(input, 'What did Ben commit to?{Enter}');
    await screen.findByText('Ben will confirm the date.');
    await userEvent.type(input, 'And wh');

    const first = server();
    await act(async () => { first.close(1006); });
    // The panel reconnects by itself after 5 seconds, and checks access first
    await waitFor(() => expect(accessCalls(fetchMock)).toHaveLength(2), { timeout: 8000 });

    expect(screen.queryByText('Confirming you\'re in this meeting…')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toBe(input);
    expect(input).toHaveValue('And wh');
    expect(screen.getByText('Ben will confirm the date.')).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();

    await act(async () => { answerSecondCheck(json({ verified: true, isGuest: false, meetingId: MEETING })); });
    await waitFor(() => {
      expect(server()).not.toBe(first);
      expect(server().readyState).toBe(FakeWebSocket.OPEN);
    });
    expect(input).toHaveValue('And wh');
    expect(screen.getByText('Ben will confirm the date.')).toBeInTheDocument();
  }, 20000);

  test('the first check still shows "Confirming you\'re in this meeting…"', async () => {
    let answer = null;
    mockFetch({ [accessPath]: () => new Promise((resolve) => { answer = resolve; }) });
    renderInMeeting();
    expect(await screen.findByText('Confirming you\'re in this meeting…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Bring Arlo into this meeting' })).not.toBeInTheDocument();

    await act(async () => { answer(json({ verified: true, isGuest: false, meetingId: MEETING })); });
    expect(await screen.findByRole('heading', { name: 'Bring Arlo into this meeting' })).toBeInTheDocument();
  });

  test('a refusal on the re-check replaces the screen with the reason', async () => {
    let checks = 0;
    const { fetchMock } = await openAsOwnerWithNotes({
      routes: {
        [accessPath]: () => {
          checks += 1;
          return checks === 1
            ? json({ verified: true, isGuest: false, meetingId: MEETING })
            : json({ error: 'This app context has expired.' }, 403);
        },
      },
    });
    await act(async () => { server().close(1006); });
    await waitFor(() => expect(accessCalls(fetchMock)).toHaveLength(2), { timeout: 8000 });

    expect(await screen.findByRole('alert')).toHaveTextContent('This app context has expired.');
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
  }, 20000);
});
