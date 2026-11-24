import { screen, waitFor, act, within, fireEvent } from '@testing-library/react';
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
const ANSWER = 'Arlo: The beta moves to March 3 so billing can finish first.';
const POST = {
  id: ID1, kind: 'agent_action', askedBy: 'Ben', channel: 'voice', question: 'Post Arlo\'s answer in the meeting chat?', primaryLabel: 'Post it',
  request: 'tell everyone when the beta is', body: ANSWER,
};
const UNVERIFIED_BEN = 'Someone shown as “Ben” asked by voice. Arlo can\'t confirm who spoke.';
const nothingShows = async () => {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
};
/** The box of the text that will be posted is `box` px high and its text `text` px (jsdom lays nothing out). */
function layOutBody({ box, text }) {
  const isBody = (node) => node.classList.contains('arlo-sheet-body');
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight() { return isBody(this) ? box : 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight() { return isBody(this) ? text : 0; });
}
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
    await send(serverMessage.approval({ ...ADMIT, askerVerified: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Admit James from the waiting room?' });
    expect(within(dialog).getByRole('heading', { name: 'Admit James from the waiting room?' })).toBeInTheDocument();
    expect(within(dialog).getByText('Ben asked Arlo to do this.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Admit James' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(within(dialog).getByText(/^\d+s$/)).toBeInTheDocument();
    // Nothing is posted: no box for a text, and no line about a request that was not given
    expect(within(dialog).queryByRole('region')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^They asked:/)).not.toBeInTheDocument();
    // The focus is on the sheet, never on a button
    expect(dialog).toHaveFocus();
  });

  test('no button text from the server: "Do it"', async () => {
    await openAsOwner();
    await send(serverMessage.approval({ id: ID1, kind: 'agent_action', question: 'Post this in the meeting chat?' }));
    const dialog = await screen.findByRole('dialog', { name: 'Post this in the meeting chat?' });
    expect(within(dialog).getByRole('button', { name: 'Do it' })).toBeInTheDocument();
  });

  describe('who asked is said only as far as the server knows it', () => {
    test.each([
      ['a name the server verified', { askedBy: 'Ben', askerVerified: true, channel: 'panel' }, 'Ben asked Arlo to do this.'],
      ['a spoken request with a display name', { askedBy: 'Ben', askerVerified: false, channel: 'voice' }, UNVERIFIED_BEN],
      ['a name and no word on whether it is verified', { askedBy: 'Ben' }, UNVERIFIED_BEN],
      ['"verified" that is not exactly true', { askedBy: 'Ben', askerVerified: 'true' }, UNVERIFIED_BEN],
      ['a spoken request with no name', { askedBy: undefined, channel: 'voice' }, 'Someone in the meeting asked by voice.'],
      ['a name that would show as a blank', { askedBy: '\u202e\u200b', channel: 'voice' }, 'Someone in the meeting asked by voice.'],
      ['a typed request the server did not verify', { askedBy: 'Ben', channel: 'panel' }, 'Someone in the meeting asked.'],
      ['a typed request with no name', { askedBy: undefined, channel: 'panel' }, 'Someone in the meeting asked.'],
    ])('%s', async (_name, extra, detail) => {
      await openAsOwner();
      await send(serverMessage.approval({ ...ADMIT, ...extra }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(detail)).toBeInTheDocument();
      expect(dialog).toHaveAccessibleDescription(detail);
    });
  });

  describe('what will be posted is shown whole', () => {
    test('the question, the text in its own box, who asked, what they asked, the buttons, the seconds: in that order', async () => {
      await openAsOwner();
      await send(serverMessage.approval(POST));
      const dialog = await screen.findByRole('dialog', { name: 'Post Arlo\'s answer in the meeting chat?' });
      const box = within(dialog).getByRole('region', { name: 'What will be posted' });
      expect(box.textContent).toBe(ANSWER);
      const order = [
        within(dialog).getByRole('heading', { name: 'Post Arlo\'s answer in the meeting chat?' }),
        box,
        within(dialog).getByText(UNVERIFIED_BEN),
        within(dialog).getByText('They asked: “tell everyone when the beta is”'),
        within(dialog).getByRole('button', { name: 'Post it' }),
        within(dialog).getByRole('button', { name: 'Not now' }),
        within(dialog).getByText(/^\d+s$/),
      ];
      order.slice(1).forEach((node, index) => {
        expect(order[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      });
      // All of it fits its box: it has been on screen, so it can be approved
      expect(within(dialog).getByRole('button', { name: 'Post it' })).toBeEnabled();
    });

    test('every character the server sends is on the sheet: 500 of text, 200 of question and request, 40 of button', async () => {
      const body = `Line one\n\n  indented ${'x'.repeat(471)} THE-END`;
      expect(body).toHaveLength(500);
      const question = `${'q'.repeat(196)}TAIL`;
      const request = `${'r'.repeat(196)}TAIL`;
      const primaryLabel = `${'b'.repeat(36)}TAIL`;
      await openAsOwner();
      await send(serverMessage.approval({ ...POST, body, question, request, primaryLabel }));
      const dialog = await screen.findByRole('dialog', { name: question });
      // Exactly the text, line breaks and spaces included
      expect(within(dialog).getByRole('region', { name: 'What will be posted' }).textContent).toBe(body);
      expect(within(dialog).getByRole('button', { name: primaryLabel })).toBeInTheDocument();
      expect(within(dialog).getByText(`They asked: “${request}”`)).toBeInTheDocument();
    });

    test.each([
      ['a question over 200 characters', { question: 'q'.repeat(201) }],
      ['a button text over 40 characters', { primaryLabel: 'b'.repeat(41) }],
      ['a text to post over 500 characters', { body: 'x'.repeat(501) }],
      ['a request over 200 characters', { request: 'r'.repeat(201) }],
      ['a name over 60 characters', { askedBy: 'n'.repeat(61) }],
      ['a button text that is not text', { primaryLabel: 7 }],
      ['a text to post that is not text', { body: ['Arlo: hello'] }],
      ['a text to post that is blank', { body: '  \n ' }],
      ['a request that is not text', { request: { text: 'post it' } }],
      ['a name that is not text', { askedBy: 42 }],
    ])('%s: the request is not shown at all, never a shortened one', async (_name, extra) => {
      const { fetchMock } = await openAsOwner();
      await send(serverMessage.approval({ ...POST, ...extra }));
      await nothingShows();
      // Left to run out on the server: not answered for the owner
      expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
    });

    test('one that cannot be shown does not hold up one that can, read from the server or announced', async () => {
      await openAsOwner({
        routes: {
          [arloPath('approvals')]: () => json({
            approvals: [
              { ...POST, body: 'x'.repeat(501), expiresAt: Date.now() + 50000 },
              { ...ADMIT, id: ID2, expiresAt: Date.now() + 60000 },
            ],
          }),
        },
      });
      expect(await screen.findByRole('dialog', { name: 'Admit James from the waiting room?' })).toBeInTheDocument();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    });

    test('a text taller than its box: it cannot be approved before its end has been scrolled into view', async () => {
      const { fetchMock } = await openAsOwner();
      layOutBody({ box: 120, text: 400 });
      await send(serverMessage.approval(POST));
      const dialog = await screen.findByRole('dialog');
      const box = within(dialog).getByRole('region', { name: 'What will be posted' });
      const post = within(dialog).getByRole('button', { name: 'Post it' });
      expect(post).toBeDisabled();
      expect(within(dialog).getByText('Scroll to the end of the message to continue.')).toBeInTheDocument();
      await pastSheetGuard();
      // Still not: the wait at the start is not what holds it
      expect(post).toBeDisabled();
      await userEvent.click(post);
      fireEvent.scroll(box, { target: { scrollTop: 150 } });
      expect(post).toBeDisabled();
      // "Not now" never waits for the text
      expect(within(dialog).getByRole('button', { name: 'Not now' })).toBeEnabled();
      expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);

      fireEvent.scroll(box, { target: { scrollTop: 280 } });
      expect(post).toBeEnabled();
      expect(within(dialog).queryByText('Scroll to the end of the message to continue.')).not.toBeInTheDocument();
      // Scrolling back up does not take it away again
      fireEvent.scroll(box, { target: { scrollTop: 0 } });
      expect(post).toBeEnabled();
      await userEvent.click(post);
      await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]));
    });

    test('scrolling to the end does not answer early: the first 700 ms still take no answer', async () => {
      const { fetchMock } = await openAsOwner();
      layOutBody({ box: 120, text: 400 });
      await send(serverMessage.approval(POST));
      const dialog = await screen.findByRole('dialog');
      fireEvent.scroll(within(dialog).getByRole('region'), { target: { scrollTop: 280 } });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Post it' }));
      expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    test('the next sheet starts over: its own text must be seen', async () => {
      await openAsOwner();
      layOutBody({ box: 120, text: 400 });
      await send(serverMessage.approval({ ...POST, expiresAt: Date.now() + 50000 }));
      await send(serverMessage.approval({ ...POST, id: ID2, body: 'Arlo: A second answer.', expiresAt: Date.now() + 60000 }));
      const first = await screen.findByRole('dialog');
      fireEvent.scroll(within(first).getByRole('region'), { target: { scrollTop: 280 } });
      expect(within(first).getByRole('button', { name: 'Post it' })).toBeEnabled();
      await send(serverMessage.approvalClosed(ID1, 'declined'));
      await screen.findByText('Arlo: A second answer.');
      expect(screen.getByRole('button', { name: 'Post it' })).toBeDisabled();
    });

    test('Tab reaches the text first, so it can be scrolled with the keys, then the buttons', async () => {
      await openAsOwner();
      await send(serverMessage.approval(POST));
      const dialog = await screen.findByRole('dialog');
      await pastSheetGuard();
      await userEvent.tab();
      expect(within(dialog).getByRole('region', { name: 'What will be posted' })).toHaveFocus();
      await userEvent.tab();
      expect(within(dialog).getByRole('button', { name: 'Post it' })).toHaveFocus();
      await userEvent.tab();
      expect(within(dialog).getByRole('button', { name: 'Not now' })).toHaveFocus();
      await userEvent.tab();
      expect(within(dialog).getByRole('region', { name: 'What will be posted' })).toHaveFocus();
    });

    test('markup in the text to post and in the request is shown as text', async () => {
      await openAsOwner();
      await send(serverMessage.approval({ ...POST, body: 'Arlo: <img src=x onerror=alert(1)> done', request: '<b>post</b> it' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('region').textContent).toBe('Arlo: <img src=x onerror=alert(1)> done');
      expect(within(dialog).getByText('They asked: “<b>post</b> it”')).toBeInTheDocument();
      expect(dialog.querySelector('img, b')).toBeNull();
    });
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
    await nothingShows();
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

  test('after two sheets in a row the focus is back where it was before the first', async () => {
    await openAsOwner();
    const input = screen.getByRole('textbox', { name: 'Ask Arlo' });
    input.focus();
    await send(serverMessage.approval({ ...ADMIT, expiresAt: Date.now() + 50000 }));
    await send(serverMessage.approval({ ...POST, id: ID2, expiresAt: Date.now() + 60000 }));
    await screen.findByRole('dialog', { name: 'Admit James from the waiting room?' });
    await pastSheetGuard();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    const second = await screen.findByRole('dialog', { name: 'Post Arlo\'s answer in the meeting chat?' });
    expect(second).toHaveFocus();
    await pastSheetGuard();
    await userEvent.click(within(second).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toHaveFocus();
  });

  test('when what had the focus is gone, the focus goes to the heading of the screen', async () => {
    await openAsOwner();
    const clear = document.createElement('button');
    screen.getByRole('textbox', { name: 'Ask Arlo' }).after(clear);
    clear.focus();
    await send(serverMessage.approval(ADMIT));
    await screen.findByRole('dialog');
    clear.remove();
    await send(serverMessage.approvalClosed(ID1, 'approved'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Your notes' })).toHaveFocus();
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

describe('the owner is asked on whatever screen they are on', () => {
  const ownerRoutes = { [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...OWNER }) };
  /** The panel knows this person is an owner once it has read the open requests. */
  const knowsOwner = (fetchMock) => waitFor(() => expect(callsTo(fetchMock, 'approvals')).not.toHaveLength(0));

  test('on the meeting record: the sheet shows, the record waits behind it, and the answer is reported', async () => {
    const fetchMock = mockFetch(ownerRoutes);
    renderInMeeting({ page: 'record' });
    const heading = await screen.findByRole('heading', { name: 'Meeting record' });
    await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
    await knowsOwner(fetchMock);
    await send(serverMessage.approval(POST));

    const dialog = await screen.findByRole('dialog', { name: 'Post Arlo\'s answer in the meeting chat?' });
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByRole('region', { name: 'What will be posted' }).textContent).toBe(ANSWER);
    expect(heading.closest('[inert]')).not.toBeNull();
    expect(heading.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(heading.closest('[inert]')).not.toContainElement(dialog);
    expect(screen.queryByRole('heading', { name: 'Meeting record' })).not.toBeInTheDocument();

    await pastSheetGuard();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Post it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]);
    // The record is in reach again; nothing had the focus, so its heading takes it
    expect(heading.closest('[inert]')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Meeting record' })).toHaveFocus();
  });

  test('in Settings: a request for the notes shows there too, and "Not now" declines it', async () => {
    const { fetchMock } = await openAsOwner();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben Okafor' }));

    const dialog = await screen.findByRole('dialog', { name: 'Share the notes with everyone in the meeting?' });
    expect(within(dialog).getByText('Ben Okafor asked to see them.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
    await pastSheetGuard();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: false }]);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings');
  });

  test('in Settings: something Arlo was asked to do shows, and agreeing reports it', async () => {
    const { fetchMock } = await openAsOwner();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings' });
    await send(serverMessage.approval({ ...ADMIT, askerVerified: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Admit James from the waiting room?' });
    await pastSheetGuard();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Admit James' }));
    await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]));
  });

  test('on the classic dashboard too', async () => {
    const fetchMock = mockFetch(ownerRoutes);
    renderInMeeting({ page: 'classic' });
    await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
    await knowsOwner(fetchMock);
    await send(serverMessage.approval(ADMIT));
    expect(await screen.findByRole('dialog', { name: 'Admit James from the waiting room?' })).toBeInTheDocument();
  });

  test('a guest on the meeting record is never asked, whatever their panel is told', async () => {
    mockFetch(ownerRoutes, { signedIn: false });
    renderInMeeting({ page: 'record', guest: true, sdk: attendee({ status: 'unauthenticated' }) });
    await screen.findByRole('heading', { name: 'Meeting record' });
    await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
    await send(serverMessage.arloState(OWNER));
    await send(serverMessage.approval(ADMIT));
    await nothingShows();
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
