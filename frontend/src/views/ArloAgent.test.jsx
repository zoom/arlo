import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage, serverMessagesFor,
  arloPath, arloAction, ARLO_ABSENT, pastSheetGuard,
} from '../test/harness';

// Arlo does what it is asked: the owner approves what other people ask for in
// a sheet, sees that Arlo is working on something, and reads what Arlo did at
// the end of the notes. Driven through the real app in a fake meeting.

const NOTES = {
  summary: 'The beta moves to March 3 so billing can finish first.',
  decisions: ['Beta launch moves to March 3'],
  actionItems: [{ text: 'Send the revised timeline', owner: 'Ana' }],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 9,
};
const OWNER = { present: true, role: 'owner', ownerName: 'Ana', myStreamLive: true };
const ANA_BROUGHT_ARLO = { present: true, role: 'participant', ownerName: 'Ana', whoCanAsk: 'owner' };
const SHARED = { ...ANA_BROUGHT_ARLO, notesShared: true };
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const OTHER = serverMessagesFor('OTHER-MEETING==');
const MEETING_2 = 'MEETING-2==';
const ADMIT = { id: ID1, kind: 'agent_action', askedBy: 'Ben', question: 'Admit James from the waiting room?', primaryLabel: 'Admit James' };
const THINKING = 'Arlo is thinking…';
const WAITING = 'Waiting for approval…';
const PLACEHOLDER = 'Ask Arlo, or say “Arlo, …”';

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const attendee = (extra = {}) => createZoomSdk({ role: 'attendee', screenName: 'Ben', ...extra });
const posted = (fetchMock, name) => fetchMock.mock.calls
  .filter(([url, init]) => String(url) === arloPath(name) && init?.method === 'POST')
  .map(([, init]) => JSON.parse(init.body));
const callsTo = (fetchMock, name) => fetchMock.mock.calls
  .filter(([url, init]) => String(url) === arloPath(name) && (init?.method || 'GET') === 'GET');
const statusLine = () => within(screen.getByRole('region', { name: 'Arlo' })).getByRole('status');
const arloDid = () => screen.queryByRole('heading', { name: 'Arlo did' });
const didLines = () => [...arloDid().parentElement.querySelectorAll('li')].map((node) => node.textContent);
const lastIndicator = (sdk) => sdk.setDynamicIndicator.mock.calls.at(-1)?.[0]?.text;
const leaveMeeting = (sdk) => act(async () => {
  sdk.emit('onRunningContextChange', { runningContext: 'inMainClient' });
});
const joinMeeting = (sdk, meetingUUID) => act(async () => {
  sdk.getMeetingUUID.mockResolvedValue({ meetingUUID });
  sdk.emit('onRunningContextChange', { runningContext: 'inMeeting' });
});

async function open({ sdk, guest = false, state = OWNER, notes = NOTES, routes = {} } = {}) {
  const fetchMock = mockFetch({ [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }), ...routes }, { signedIn: !guest });
  const result = renderInMeeting({ sdk, guest });
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.arloState(state));
  if (notes) await send(serverMessage.notes(notes));
  return { ...result, fetchMock };
}
async function openAsOwner(options = {}) {
  const result = await open(options);
  await screen.findByText('Arlo is in the meeting');
  if (options.notes !== null) await screen.findByText((options.notes || NOTES).summary);
  return result;
}
async function openAsParticipant({ sdk = attendee(), state = ANA_BROUGHT_ARLO, ...options } = {}) {
  const result = await open({ sdk, state, notes: null, ...options });
  await screen.findByRole('heading', { name: /Arlo/ });
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHarness();
  localStorage.clear();
});

describe('the sheet for something Arlo was asked to do', () => {
  test('the server\'s question, who asked, the server\'s button, "Not now" and the seconds left', async () => {
    await openAsOwner();
    await send(serverMessage.approval(ADMIT));
    const dialog = await screen.findByRole('dialog', { name: 'Admit James from the waiting room?' });
    expect(within(dialog).getByText('Ben asked Arlo to do this.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Admit James' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(within(dialog).getByText(/^\d+s$/)).toBeInTheDocument();
    // The focus is on the sheet, never on a button
    expect(dialog).toHaveFocus();
  });

  test('nobody named, and no button text from the server: "Someone asked Arlo to do this." and "Do it"', async () => {
    await openAsOwner();
    await send(serverMessage.approval({ id: ID1, kind: 'agent_action', question: 'Post this to the chat?' }));
    const dialog = await screen.findByRole('dialog', { name: 'Post this to the chat?' });
    expect(within(dialog).getByText('Someone asked Arlo to do this.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Do it' })).toBeInTheDocument();
  });

  test('approving reports { approve: true } and nothing else: the panel itself does nothing', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.approval(ADMIT));
    const dialog = await screen.findByRole('dialog');
    // For its first moments the sheet takes no answer
    await userEvent.click(within(dialog).getByRole('button', { name: 'Admit James' }));
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
    await pastSheetGuard();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Admit James' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]);
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(sdk.getWaitingRoomParticipants).not.toHaveBeenCalled();
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    expect(screen.queryByText('Notes are now shared with everyone')).not.toBeInTheDocument();
  });

  test('"Not now" reports { approve: false }; so does Escape', async () => {
    const { fetchMock } = await openAsOwner();
    await send(serverMessage.approval(ADMIT));
    await screen.findByRole('dialog');
    await pastSheetGuard();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: false }]);

    await send(serverMessage.approval({ ...ADMIT, id: ID2 }));
    await screen.findByRole('dialog');
    await pastSheetGuard();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posted(fetchMock, `approvals/${ID2}`)).toEqual([{ approve: false }]);
  });

  test.each([
    ['no question', { question: undefined }],
    ['an empty question', { question: '   ' }],
    ['a question that is not text', { question: { text: 'Admit James?' } }],
  ])('one with %s is ignored', async (_name, extra) => {
    await openAsOwner();
    await send(serverMessage.approval({ ...ADMIT, ...extra }));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('long texts from the server are cut: 300 characters of question, 60 of button', async () => {
    await openAsOwner();
    await send(serverMessage.approval({ ...ADMIT, question: `${'q'.repeat(300)}TAIL`, primaryLabel: `${'b'.repeat(60)}TAIL` }));
    const dialog = await screen.findByRole('dialog', { name: 'q'.repeat(300) });
    expect(within(dialog).getByRole('button', { name: 'b'.repeat(60) })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('TAIL');
  });

  test('markup in the server\'s texts is shown as text', async () => {
    await openAsOwner();
    await send(serverMessage.approval({ ...ADMIT, question: 'Admit <img src=x onerror=alert(1)> James?', primaryLabel: '<b>Admit</b>' }));
    const dialog = await screen.findByRole('dialog', { name: 'Admit <img src=x onerror=alert(1)> James?' });
    expect(dialog.querySelector('img, b')).toBeNull();
  });

  test('one read from the server when the panel opens is shown too; another owner\'s answer closes it', async () => {
    await openAsOwner({
      routes: { [arloPath('approvals')]: () => json({ approvals: [{ ...ADMIT, expiresAt: Date.now() + 60000 }] }) },
    });
    await screen.findByRole('dialog', { name: 'Admit James from the waiting room?' });
    await send(serverMessage.approvalClosed(ID1, 'approved'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('it waits behind a request for the notes that came first', async () => {
    await openAsOwner();
    await send(serverMessage.approval({ id: ID2, askedBy: 'Bo', expiresAt: Date.now() + 50000 }));
    await send(serverMessage.approval({ ...ADMIT, expiresAt: Date.now() + 60000 }));
    await screen.findByRole('dialog', { name: 'Share the notes with everyone in the meeting?' });
    await send(serverMessage.approvalClosed(ID2, 'declined'));
    expect(await screen.findByRole('dialog', { name: 'Admit James from the waiting room?' })).toBeInTheDocument();
  });

  test('a participant is never shown one, and one for another meeting is ignored', async () => {
    await openAsParticipant();
    await send(serverMessage.approval(ADMIT));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    resetHarness();

    await openAsOwner();
    await send(OTHER.approval(ADMIT));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Arlo is thinking', () => {
  test('the status line says so while it is on, and its usual text when it is off', async () => {
    await openAsOwner();
    expect(statusLine()).toHaveTextContent('Arlo is in the meeting');
    await send(serverMessage.thinking(true));
    await waitFor(() => expect(statusLine()).toHaveTextContent(THINKING));
    expect(screen.queryByText('Arlo is in the meeting')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    await send(serverMessage.thinking(false));
    await waitFor(() => expect(statusLine()).toHaveTextContent('Arlo is in the meeting'));
  });

  test('without an "off" it ends by itself after 30 seconds, counted from the last "on"', async () => {
    await openAsOwner();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await send(serverMessage.thinking(true));
    await waitFor(() => expect(statusLine()).toHaveTextContent(THINKING));
    await act(async () => { vi.advanceTimersByTime(20000); });
    await send(serverMessage.thinking(true));
    await act(async () => { vi.advanceTimersByTime(20000); });
    expect(statusLine()).toHaveTextContent(THINKING);
    await act(async () => { vi.advanceTimersByTime(11000); });
    expect(statusLine()).toHaveTextContent('Arlo is in the meeting');
  });

  test('another meeting\'s thinking, and anything but true, is not this panel\'s', async () => {
    await openAsOwner();
    await send(OTHER.thinking(true));
    await send(serverMessage.thinking('yes'));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(statusLine()).toHaveTextContent('Arlo is in the meeting');
  });

  test('a participant\'s panel shows nothing of it', async () => {
    await openAsParticipant();
    await send(serverMessage.thinking(true));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(screen.queryByText(THINKING)).not.toBeInTheDocument();
  });

  describe('in Zoom\'s indicator', () => {
    /** This panel brought Arlo in, and the stream is confirmed: it owns the indicator. */
    async function broughtInHere() {
      const fetchMock = mockFetch();
      const result = renderInMeeting();
      await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
      await userEvent.click(await screen.findByRole('button', { name: 'Bring Arlo into this meeting' }));
      await send(serverMessage.status('rtms_started'));
      await send(serverMessage.arloState(OWNER));
      await screen.findByText('Arlo is in the meeting');
      await waitFor(() => expect(lastIndicator(result.sdk)).toBe('Arlo is transcribing'));
      return { ...result, fetchMock };
    }

    test('the panel that owns the indicator shows "Arlo is thinking…" and goes back to transcribing', async () => {
      const { sdk } = await broughtInHere();
      await send(serverMessage.thinking(true));
      await waitFor(() => expect(lastIndicator(sdk)).toBe(THINKING));
      await send(serverMessage.thinking(false));
      await waitFor(() => expect(lastIndicator(sdk)).toBe('Arlo is transcribing'));
    });

    test('paused wins over thinking', async () => {
      const { sdk } = await broughtInHere();
      await send(serverMessage.status('rtms_paused'));
      await send(serverMessage.arloState({ ...OWNER, paused: true, myStreamPaused: true }));
      await waitFor(() => expect(lastIndicator(sdk)).toBe('Arlo is paused'));
      await send(serverMessage.thinking(true));
      await waitFor(() => expect(statusLine()).toHaveTextContent(THINKING));
      expect(lastIndicator(sdk)).toBe('Arlo is paused');
    });

    test('an owner\'s panel that did not start the stream sets no indicator', async () => {
      const { sdk } = await openAsOwner();
      await send(serverMessage.thinking(true));
      await waitFor(() => expect(statusLine()).toHaveTextContent(THINKING));
      expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
    });
  });
});

describe('"Arlo did" at the end of the notes', () => {
  const done = arloAction({ id: ID1, at: 1000, label: 'Admitted James from the waiting room', askedBy: 'Ben', tool: 'admit_from_waiting_room' });
  const own = arloAction({ id: ID2, at: 2000, label: 'Summarized the meeting so far', tool: 'summarize_so_far', channel: 'panel', isPublic: false });

  test('nothing done: no such section', async () => {
    const { fetchMock } = await openAsOwner();
    await waitFor(() => expect(callsTo(fetchMock, 'actions')).not.toHaveLength(0));
    expect(callsTo(fetchMock, 'actions')[0][1]).toEqual({ credentials: 'include' });
    expect(arloDid()).not.toBeInTheDocument();
  });

  test('what was done when the panel opened, oldest first, after the action items', async () => {
    await openAsOwner({ routes: { [arloPath('actions')]: () => json({ actions: [own, done] }) } });
    await waitFor(() => expect(arloDid()).toBeInTheDocument());
    expect(didLines()).toEqual(['Admitted James from the waiting room · Ben asked', 'Summarized the meeting so far']);
    const headings = within(screen.getByRole('article', { name: 'Notes' })).getAllByRole('heading').map((node) => node.textContent);
    expect(headings).toEqual(['Summary', 'Decisions', 'Action items', 'Arlo did']);
  });

  test('an action that ends while the panel is open is added; the same one again is not added twice', async () => {
    await openAsOwner();
    await send(serverMessage.did({ ...done, status: 'waiting_approval' }));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); });
    expect(arloDid()).not.toBeInTheDocument();

    await send(serverMessage.did(done));
    await waitFor(() => expect(arloDid()).toBeInTheDocument());
    await send(serverMessage.did(done));
    // An earlier word that arrives late does not take it back
    await send(serverMessage.did({ ...done, status: 'waiting_approval' }));
    expect(didLines()).toEqual(['Admitted James from the waiting room · Ben asked']);
  });

  test('what was declined, ran out or failed is not in the notes', async () => {
    await openAsOwner();
    await send(serverMessage.did(arloAction({ id: ID1, label: 'Admit James from the waiting room', status: 'declined' })));
    await send(serverMessage.did(arloAction({ id: ID2, label: 'Post to the chat', status: 'failed' })));
    await send(serverMessage.did(arloAction({ id: '33333333-3333-4333-8333-333333333333', label: 'Post again', status: 'expired' })));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); });
    expect(arloDid()).not.toBeInTheDocument();
  });

  test('before the first notes are written, what Arlo did shows all the same', async () => {
    await openAsOwner({ notes: null });
    await send(serverMessage.did(done));
    await waitFor(() => expect(arloDid()).toBeInTheDocument());
    expect(screen.getByText('Arlo is listening. Notes appear after the first minute or so.')).toBeInTheDocument();
  });

  test('another meeting\'s action, and one that is not an action, are not shown; markup is text', async () => {
    await openAsOwner();
    await send(OTHER.did(done));
    await send(serverMessage.did({ id: ID2, label: 'No status or time' }));
    await send(serverMessage.did(arloAction({ id: ID1, label: '<img src=x> Posted', askedBy: '<b>Ben</b>' })));
    await waitFor(() => expect(arloDid()).toBeInTheDocument());
    expect(didLines()).toEqual(['<img src=x> Posted · <b>Ben</b> asked']);
    expect(arloDid().parentElement.querySelector('img, b')).toBeNull();
  });

  test('someone reading shared notes sees the public ones, and never a private one', async () => {
    await openAsParticipant({ state: SHARED, routes: { [arloPath('actions')]: () => json({ actions: [done] }) } });
    await send(serverMessage.notes(NOTES));
    await screen.findByText(NOTES.summary);
    await waitFor(() => expect(arloDid()).toBeInTheDocument());
    // A private one that reaches this panel anyway is not kept
    await send(serverMessage.did(own));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); });
    expect(didLines()).toEqual(['Admitted James from the waiting room · Ben asked']);
  });

  test('a guest reading shared notes sees the public ones too', async () => {
    await open({
      guest: true,
      sdk: createZoomSdk({ status: 'authenticated', role: 'attendee', screenName: 'Guest' }),
      state: SHARED,
      routes: { [arloPath('actions')]: () => json({ actions: [done] }) },
    });
    await screen.findByText(NOTES.summary);
    await waitFor(() => expect(arloDid()).toBeInTheDocument());
    expect(didLines()).toEqual(['Admitted James from the waiting room · Ben asked']);
  });

  test('an owner who is no longer one keeps no private action', async () => {
    await openAsOwner({ routes: { [arloPath('actions')]: () => json({ actions: [own, done] }) } });
    await waitFor(() => expect(arloDid()).toBeInTheDocument());
    await send(serverMessage.arloState(SHARED));
    await screen.findByRole('heading', { name: 'Ana is sharing Arlo\'s notes' });
    await waitFor(() => expect(didLines()).toEqual(['Admitted James from the waiting room · Ben asked']));
  });

  test('after the meeting the owner\'s notes keep it; the next meeting shows none of it', async () => {
    const { sdk } = await openAsOwner({
      routes: {
        [arloPath('actions')]: () => json({ actions: [done] }),
        [arloPath('state', MEETING_2)]: () => json({ ...ARLO_ABSENT, ...OWNER }),
        [arloPath('notes', MEETING_2)]: () => json({ notes: { ...NOTES, summary: 'Notes of the second meeting.' } }),
      },
    });
    await waitFor(() => expect(arloDid()).toBeInTheDocument());
    await send(serverMessage.thinking(true));
    await leaveMeeting(sdk);
    await screen.findByRole('button', { name: 'Copy notes' });
    expect(didLines()).toEqual(['Admitted James from the waiting room · Ben asked']);

    await joinMeeting(sdk, MEETING_2);
    expect(await screen.findByText('Notes of the second meeting.')).toBeInTheDocument();
    expect(arloDid()).not.toBeInTheDocument();
    expect(screen.queryByText(THINKING)).not.toBeInTheDocument();
  });

  test('when the session ends, what Arlo did is gone with the notes', async () => {
    let sessionValid = true;
    const { sdk } = await openAsOwner({
      routes: {
        [arloPath('actions')]: () => json({ actions: [done] }),
        '/api/auth/me': () => (sessionValid
          ? json({ user: { id: 'user-1', displayName: 'Ana' } })
          : json({ error: 'Not authenticated' }, 401)),
        '/api/highlights': () => (sessionValid ? json({}) : json({ error: 'Unauthorized' }, 401)),
      },
    });
    await waitFor(() => expect(arloDid()).toBeInTheDocument());
    await leaveMeeting(sdk);
    await screen.findByRole('button', { name: 'Copy notes' });

    sessionValid = false;
    await act(async () => { await fetch('/api/highlights', { credentials: 'include' }); });
    await waitFor(() => expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument());
    expect(arloDid()).not.toBeInTheDocument();
    expect(screen.queryByText('Admitted James from the waiting room · Ben asked')).not.toBeInTheDocument();
  });
});

describe('asking Arlo to do something', () => {
  const askWith = (answer) => ({ [`POST ${arloPath('ask')}`]: () => answer });
  const type = (text) => userEvent.type(screen.getByRole('textbox', { name: 'Ask Arlo' }), `${text}{Enter}`);

  test('the input says that Arlo can be asked aloud too', async () => {
    await openAsOwner();
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toHaveAttribute('placeholder', PLACEHOLDER);
  });

  test('something done at once: the server\'s sentence, and no waiting', async () => {
    await openAsOwner({
      routes: askWith(json({ answer: 'Done: posted to the chat.', action: { tool: 'post_to_chat', status: 'done', label: 'Posted to the chat' } })),
    });
    await type('post the date to the chat');
    expect(await screen.findByText('Done: posted to the chat.')).toBeInTheDocument();
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument();
  });

  test('something that needs approval: "Waiting for approval…" until it ends', async () => {
    await openAsParticipant({
      state: { ...ANA_BROUGHT_ARLO, whoCanAsk: 'anyone' },
      routes: askWith(json({
        answer: 'I asked Ana to approve that.',
        action: { tool: 'admit_from_waiting_room', status: 'waiting_approval', label: 'Admit James from the waiting room' },
      })),
    });
    await type('let James in');
    expect(await screen.findByText('I asked Ana to approve that.')).toBeInTheDocument();
    expect(screen.getByText(WAITING)).toHaveAttribute('role', 'status');

    // Another tool's action ending says nothing about this one
    await send(serverMessage.did(arloAction({ id: ID2, tool: 'post_to_chat' })));
    await send(serverMessage.did(arloAction({ id: ID1, tool: 'admit_from_waiting_room', status: 'waiting_approval' })));
    expect(screen.getByText(WAITING)).toBeInTheDocument();

    await send(serverMessage.did(arloAction({ id: ID1, tool: 'admit_from_waiting_room', status: 'declined' })));
    await waitFor(() => expect(screen.queryByText(WAITING)).not.toBeInTheDocument());
    expect(screen.getByText('I asked Ana to approve that.')).toBeInTheDocument();
  });

  test('with no word of how it ended, the waiting line goes after 70 seconds', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await openAsOwner({
      routes: askWith(json({ answer: 'I asked for approval.', action: { tool: 'post_to_chat', status: 'waiting_approval', label: 'Post to the chat' } })),
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.type(screen.getByRole('textbox', { name: 'Ask Arlo' }), 'post it{Enter}');
    await screen.findByText(WAITING);
    await act(async () => { vi.advanceTimersByTime(69000); });
    expect(screen.getByText(WAITING)).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument();
  });

  test('Clear takes the waiting line away with the answer', async () => {
    await openAsOwner({
      routes: askWith(json({ answer: 'I asked for approval.', action: { tool: 'post_to_chat', status: 'waiting_approval', label: 'Post' } })),
    });
    await type('post it');
    await screen.findByText(WAITING);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument();
  });

  test('an action the panel does not know the shape of is an answer like any other', async () => {
    await openAsOwner({ routes: askWith(json({ answer: 'Ben will confirm.', action: { tool: 7, status: 'waiting_approval' } })) });
    await type('what did Ben say');
    expect(await screen.findByText('Ben will confirm.')).toBeInTheDocument();
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument();
  });

  test('429: "Arlo is busy. Try again in a moment."', async () => {
    await openAsOwner({ routes: askWith(json({ error: 'Arlo is busy with other requests.' }, 429)) });
    await type('summarize');
    expect(await screen.findByRole('alert')).toHaveTextContent('Arlo is busy. Try again in a moment.');
  });
});

test('the participant view still says who can ask', async () => {
  await openAsParticipant();
  expect(screen.getByText('Only people using Arlo can ask in this meeting.')).toBeInTheDocument();
});
