import { screen, waitFor, act, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
  arloPath, ARLO_ABSENT, pastSheetGuard,
} from '../test/harness';

// A participant asks the owner to share the notes with everyone; the owner
// answers in a sheet over the notes; the server turns sharing on. What
// sharing then shows is in SharedNotes.test.jsx.
// Driven through the real app in a fake meeting.

const NOTES = {
  summary: 'The beta moves to March 3 so billing can finish first.',
  decisions: ['Beta launch moves to March 3'],
  actionItems: [{ text: 'Send the revised timeline', owner: 'Ana' }],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 9,
};
const OWNER = { present: true, role: 'owner', ownerName: 'Ana', myStreamLive: true };
const ANA_BROUGHT_ARLO = { present: true, role: 'participant', ownerName: 'Ana', whoCanAsk: 'owner' };
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const QUESTION = 'Share the notes with everyone in the meeting?';
const ASKED = 'Asked. The notes appear here if they agree.';

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const sheet = () => screen.queryByRole('dialog', { name: QUESTION });
const findSheet = () => screen.findByRole('dialog', { name: QUESTION });
/** The sheet, once it takes an answer (it takes none for the first 700 ms). */
const findArmedSheet = async () => {
  const dialog = await findSheet();
  await pastSheetGuard();
  return dialog;
};
/** The seconds the sheet says are left. */
const countdown = (dialog) => Number.parseInt(within(dialog).getByText(/^\d+s$/).textContent, 10);
const approvalCalls = (fetchMock) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(arloPath('approvals')));
const attendee = (extra = {}) => createZoomSdk({ role: 'attendee', screenName: 'Ben', ...extra });

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
  await screen.findByRole('heading', { name: /Arlo (into|is in) this meeting/ });
  return result;
}

/** The bodies posted to a route of Arlo's, in order. */
const posted = (fetchMock, name) => fetchMock.mock.calls
  .filter(([url, init]) => String(url) === arloPath(name) && init?.method === 'POST')
  .map(([, init]) => JSON.parse(init.body));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHarness();
});

describe('the owner is asked in a sheet over the notes', () => {
  test('with the name of the person who asked, the focus on the sheet and on no button, and the notes behind inert', async () => {
    await openAsOwner();
    expect(sheet()).not.toBeInTheDocument();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben Okafor' }));

    const dialog = await findSheet();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Ben Okafor asked to see them.')).toBeInTheDocument();
    const share = within(dialog).getByRole('button', { name: 'Share notes' });
    expect(share).toBeEnabled();
    // The focus comes to the sheet itself: a key already on its way lands on no button
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAttribute('tabindex', '-1');
    expect(share).not.toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toBeEnabled();
    expect(within(dialog).getByText(/^\d+s$/)).toBeInTheDocument();

    // The notes are still there, dimmed and out of reach
    const behind = screen.getByText(NOTES.summary).closest('[inert]');
    expect(behind).not.toBeNull();
    expect(behind).toHaveAttribute('aria-hidden', 'true');
    expect(behind).not.toContainElement(dialog);
    expect(screen.queryByRole('textbox', { name: 'Ask Arlo' })).not.toBeInTheDocument();
  });

  test('without a name it says someone asked', async () => {
    await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: null }));
    expect(within(await findSheet()).getByText('Someone in the meeting asked to see them.')).toBeInTheDocument();
    // a name that would show as a blank is no name
    await send(serverMessage.approvalClosed(ID1, 'declined'));
    await send(serverMessage.approval({ id: ID2, askedBy: '‮​' }));
    expect(within(await findSheet()).getByText('Someone in the meeting asked to see them.')).toBeInTheDocument();
  });

  test('"Share notes" reports the agreement once and says the notes are shared; nothing goes to the chat', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await userEvent.click(within(await findArmedSheet()).getByRole('button', { name: 'Share notes' }));

    expect(await screen.findByText('Notes are now shared with everyone')).toBeInTheDocument();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    // the notes are in reach again
    expect(screen.getByText(NOTES.summary).closest('[inert]')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toBeInTheDocument();
  });

  test('both buttons are disabled while the answer is on its way', async () => {
    let resolve;
    const { fetchMock } = await openAsOwner({
      routes: { [`POST ${arloPath('approvals/')}`]: () => new Promise((res) => { resolve = () => res(json({ id: ID1, outcome: 'approved' })); }) },
    });
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    const dialog = await findArmedSheet();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share notes' }));

    expect(within(dialog).getByRole('button', { name: 'Share notes' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]);

    await act(async () => { resolve(); });
    expect(await screen.findByText('Notes are now shared with everyone')).toBeInTheDocument();
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]);
  });

  test.each([
    ['the server refuses the answer', () => json({ error: 'not_found', message: 'server words' }, 404)],
    ['the server agreed but could not share', ({ url }) => json({ id: url.split('/').pop(), outcome: 'failed' })],
  ])('%s: an error toast, and the sheet goes', async (_name, answer) => {
    const { fetchMock } = await openAsOwner({ routes: { [`POST ${arloPath('approvals/')}`]: answer } });
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await userEvent.click(within(await findArmedSheet()).getByRole('button', { name: 'Share notes' }));

    expect(await screen.findByText('Couldn\'t share the notes. Try again.')).toBeInTheDocument();
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]);
    expect(screen.queryByText('Notes are now shared with everyone')).not.toBeInTheDocument();
    expect(screen.queryByText('server words')).not.toBeInTheDocument();
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
  });

  test('no notes yet: the owner can agree all the same, they are shared as they come', async () => {
    const { sdk, fetchMock } = await openAsOwner({ notes: null });
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await userEvent.click(within(await findArmedSheet()).getByRole('button', { name: 'Share notes' }));

    expect(await screen.findByText('Notes are now shared with everyone')).toBeInTheDocument();
    await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]));
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('"Not now" declines and posts nothing to the chat', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await userEvent.click(within(await findArmedSheet()).getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: false }]));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('Escape is "Not now", once the sheet takes an answer', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await findSheet();
    // an Escape held down from before the sheet opened declines nothing
    await userEvent.keyboard('{Escape}');
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
    expect(sheet()).toBeInTheDocument();
    await pastSheetGuard();
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: false }]));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('Tab stays inside the sheet, and the focus returns to where it was when it closes', async () => {
    await openAsOwner();
    const input = screen.getByRole('textbox', { name: 'Ask Arlo' });
    input.focus();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    const dialog = await findArmedSheet();
    const share = within(dialog).getByRole('button', { name: 'Share notes' });
    const notNow = within(dialog).getByRole('button', { name: 'Not now' });
    expect(dialog).toHaveFocus();
    await userEvent.tab();
    expect(share).toHaveFocus();
    await userEvent.tab();
    expect(notNow).toHaveFocus();
    await userEvent.tab();
    expect(share).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(notNow).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toHaveFocus();
  });

  test('another owner answered: the sheet just disappears', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await findSheet();
    await send(serverMessage.approvalClosed(ID1, 'approved'));

    expect(sheet()).not.toBeInTheDocument();
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(screen.queryByText('Notes are now shared with everyone')).not.toBeInTheDocument();
  });

  test('it runs out a minute after it arrived, and is never answered for the owner', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await findSheet();
    await act(async () => { vi.advanceTimersByTime(58000); });
    expect(sheet()).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(sheet()).not.toBeInTheDocument();
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('a time left that the server gives is the one that counts', async () => {
    await openAsOwner();
    await send({ ...serverMessage.approval({ id: ID1, askedBy: 'Ben' }), data: { ...serverMessage.approval({ id: ID1, askedBy: 'Ben' }).data, expiresInMs: 20000 } });
    const left = countdown(await findSheet());
    expect(left).toBeGreaterThanOrEqual(19);
    expect(left).toBeLessThanOrEqual(20);
    // none left: not shown at all
    await send(serverMessage.approvalClosed(ID1, 'declined'));
    await send({ type: 'arlo.approval', data: { ...serverMessage.approval({ id: ID2, askedBy: 'Dee' }).data, expiresInMs: 0 } });
    expect(sheet()).not.toBeInTheDocument();
  });

  test('two requests wait in line, oldest first; a repeated message is not a second request', async () => {
    const { fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await send(serverMessage.approval({ id: ID2, askedBy: 'Dee' }));
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    expect(within(await findArmedSheet()).getByText('Ben asked to see them.')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await screen.findByText('Dee asked to see them.');
    // the next sheet is a new question: the focus on the sheet, and its own wait
    expect(sheet()).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(posted(fetchMock, `approvals/${ID2}`)).toEqual([]);
    await pastSheetGuard();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: false }]);
    expect(posted(fetchMock, `approvals/${ID2}`)).toEqual([{ approve: false }]);
    // an answered one that is announced again stays answered
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    expect(sheet()).not.toBeInTheDocument();
  });

  test('a panel that reloads reads the open request from the server', async () => {
    await openAsOwner({
      routes: {
        [arloPath('approvals')]: () => json({ approvals: [serverMessage.approval({ id: ID1, askedBy: 'Ben' }).data] }),
      },
    });
    expect(within(await findArmedSheet()).getByText('Ben asked to see them.')).toBeInTheDocument();
    // the same one over the socket is not a second one
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
  });

  test('a kind this panel does not know is not shown and not answered', async () => {
    const { fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben', kind: 'admit_from_waiting_room' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // and it does not hold up one that is known
    await send(serverMessage.approval({ id: ID2, askedBy: 'Dee' }));
    expect(within(await findSheet()).getByText('Dee asked to see them.')).toBeInTheDocument();
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
  });

  test('a request about another meeting, or one that is not a request, is ignored', async () => {
    await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }, 'ANOTHER-MEETING=='));
    await send({ type: 'arlo.approval', data: { meetingId: 'MEETING-1==', id: 42, kind: 'share_notes', expiresAt: Date.now() + 60000 } });
    await send({ type: 'arlo.approval', data: { meetingId: 'MEETING-1==', id: ID2, kind: 'share_notes', expiresAt: 'soon' } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // and another meeting's close does not close this meeting's
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await findSheet();
    await send(serverMessage.approvalClosed(ID1, 'declined', 'ANOTHER-MEETING=='));
    expect(sheet()).toBeInTheDocument();
  });

  test('a participant never sees a sheet, even if the message reaches their panel', async () => {
    const { fetchMock } = await openAsParticipant();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Dee' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    // and a participant's panel does not ask for the list
    expect(approvalCalls(fetchMock)).toEqual([]);
  });

  test('a participant\'s panel does not hold a request it was sent: none shows when they become an owner', async () => {
    const { fetchMock } = await openAsParticipant();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Dee' }));
    expect(approvalCalls(fetchMock)).toEqual([]);

    await send(serverMessage.arloState(OWNER));
    await screen.findByText('Arlo is in the meeting');
    // an owner reads the open ones from the server (none here), and only those
    await waitFor(() => expect(approvalCalls(fetchMock)).toHaveLength(1));
    await pastSheetGuard();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('an owner who stops being one holds none: back as an owner, only what the server lists shows', async () => {
    const { fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await findSheet();
    await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    const before = approvalCalls(fetchMock).length;

    await send(serverMessage.arloState(OWNER));
    await waitFor(() => expect(approvalCalls(fetchMock)).toHaveLength(before + 1));
    await pastSheetGuard();
    expect(sheet()).not.toBeInTheDocument();
  });

  test.each([
    ['told it is a participant', ANA_BROUGHT_ARLO],
    // What a panel is told is never enough: not signed in is never an owner
    ['told it is an owner', OWNER],
  ])('a guest\'s panel, %s, never asks for the list and never shows a sheet', async (_name, state) => {
    const { fetchMock } = await open({ sdk: attendee({ status: 'unauthenticated' }), guest: true, state, notes: null });
    await screen.findByRole('button', { name: 'Sign in to ask Arlo' });
    await send(serverMessage.approval({ id: ID1, askedBy: 'Dee' }));
    await send(serverMessage.arloState(state));
    await pastSheetGuard();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    expect(approvalCalls(fetchMock)).toEqual([]);
  });
});

describe('a key or a click already on its way never answers the sheet', () => {
  const askInput = () => screen.getByRole('textbox', { name: 'Ask Arlo', hidden: true });

  test('the owner is typing a question when the sheet opens: nothing is agreed to, and the text stays', async () => {
    const { fetchMock } = await openAsOwner();
    await userEvent.type(screen.getByRole('textbox', { name: 'Ask Arlo' }), 'what did');
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await findSheet();
    await userEvent.keyboard(' we decide{Enter}');

    expect(approvalCalls(fetchMock).filter(([, init]) => init?.method === 'POST')).toEqual([]);
    expect(posted(fetchMock, 'ask')).toEqual([]);
    expect(sheet()).toBeInTheDocument();
    expect(askInput()).toHaveValue('what did');

    // the same keys later, still on the sheet and on no button: nothing
    await pastSheetGuard();
    await userEvent.keyboard(' {Enter}');
    expect(approvalCalls(fetchMock).filter(([, init]) => init?.method === 'POST')).toEqual([]);
    expect(sheet()).toBeInTheDocument();

    // answered: the text is still there, with the focus
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toHaveValue('what did');
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toHaveFocus();
  });

  test.each([
    ['Share notes', { approve: true }],
    ['Not now', { approve: false }],
  ])('a click on "%s" in the first 700 ms does nothing; after that it answers', async (name, body) => {
    const { fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    const dialog = await findSheet();
    await userEvent.click(within(dialog).getByRole('button', { name }));
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
    expect(sheet()).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name })).toBeEnabled();

    await pastSheetGuard();
    await userEvent.click(within(dialog).getByRole('button', { name }));
    await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([body]));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
  });

  test('Enter or Space on a button reached by Tab in the first 700 ms does nothing', async () => {
    const { fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    const dialog = await findSheet();
    await userEvent.tab();
    expect(within(dialog).getByRole('button', { name: 'Share notes' })).toHaveFocus();
    await userEvent.keyboard('{Enter} ');
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
    expect(sheet()).toBeInTheDocument();
  });

  test('Escape declines wherever the focus is, but not in the first 700 ms', async () => {
    const { fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await findSheet();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
    expect(sheet()).toBeInTheDocument();

    await pastSheetGuard();
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: false }]));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    // no listener is left behind
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: false }]);
  });
});

describe('nothing outside the sheet is in reach while it is open', () => {
  test('the header\'s buttons cannot be reached by Tab, focus or click, and can again afterwards', async () => {
    await openAsOwner();
    const settings = screen.getByRole('button', { name: 'Settings' });
    const back = screen.getByRole('button', { name: 'Back' });
    expect(settings.closest('[inert]')).toBeNull();
    const address = window.location.hash;

    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    const dialog = await findArmedSheet();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    for (const button of [settings, back]) {
      expect(button.closest('[inert]')).not.toBeNull();
      expect(button.closest('[aria-hidden="true"]')).not.toBeNull();
    }
    // Tab goes round the sheet's two buttons only
    const seen = new Set();
    for (let i = 0; i < 6; i += 1) {
      await userEvent.tab();
      seen.add(document.activeElement);
    }
    expect([...seen]).toEqual([
      within(dialog).getByRole('button', { name: 'Share notes' }), within(dialog).getByRole('button', { name: 'Not now' }),
    ]);
    // a browser without `inert`: the focus does not stay outside, and a click does nothing
    act(() => { settings.focus(); });
    expect(dialog).toContainElement(document.activeElement);
    await userEvent.click(settings);
    await userEvent.click(back);
    expect(window.location.hash).toBe(address);
    expect(sheet()).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Back' })).toBe(back);
    expect(settings.closest('[inert]')).toBeNull();
    expect(settings.closest('[aria-hidden]')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
  });

  test('what was made inert is given back when the panel goes away with the sheet open', async () => {
    const outside = document.createElement('button');
    const already = document.createElement('div');
    already.setAttribute('aria-hidden', 'true');
    document.body.append(outside, already);
    try {
      const { unmount } = await openAsOwner();
      await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
      await findSheet();
      expect(outside).toHaveAttribute('inert');
      expect(outside).toHaveAttribute('aria-hidden', 'true');
      unmount();
      expect(outside).not.toHaveAttribute('inert');
      expect(outside).not.toHaveAttribute('aria-hidden');
      // what was hidden before stays as it was
      expect(already).toHaveAttribute('aria-hidden', 'true');
      expect(already).not.toHaveAttribute('inert');
    } finally {
      outside.remove();
      already.remove();
    }
  });
});

describe('the time left does not depend on the panel\'s clock', () => {
  const MINUTES = 60 * 1000;
  /** The panel's clock is `ms` ahead of the server's (behind when negative). */
  const skewPanelClock = (ms) => {
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + ms);
    return real;
  };
  const expectFullWindow = (dialog) => {
    expect(countdown(dialog)).toBeGreaterThanOrEqual(58);
    expect(countdown(dialog)).toBeLessThanOrEqual(60);
  };

  test.each([
    ['five minutes ahead', 5 * MINUTES],
    ['five minutes behind', -5 * MINUTES],
  ])('a request that arrives while the panel\'s clock is %s shows, with a minute to answer', async (_name, skew) => {
    await openAsOwner();
    const serverNow = skewPanelClock(skew);
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben', expiresAt: serverNow() + 60000 }));
    expectFullWindow(await findSheet());
  });

  test.each([
    ['five minutes ahead', 5 * MINUTES],
    ['five minutes behind', -5 * MINUTES],
  ])('a request read from the server while the panel\'s clock is %s shows, with a minute to answer', async (_name, skew) => {
    const serverNow = skewPanelClock(skew);
    await openAsOwner({
      routes: { [arloPath('approvals')]: () => json({ approvals: [serverMessage.approval({ id: ID1, askedBy: 'Ben', expiresAt: serverNow() + 20000 }).data] }) },
    });
    expectFullWindow(await findSheet());
  });

  test('read from the server with clocks that agree: the server\'s time is the one shown', async () => {
    await openAsOwner({
      routes: { [arloPath('approvals')]: () => json({ approvals: [serverMessage.approval({ id: ID1, askedBy: 'Ben', expiresAt: Date.now() + 20000 }).data] }) },
    });
    const left = countdown(await findSheet());
    expect(left).toBeGreaterThanOrEqual(18);
    expect(left).toBeLessThanOrEqual(20);
  });

  test('read from the server, which says what time it has: the time left is by the server\'s clock', async () => {
    // Half a minute ahead: by the panel's clock alone 10 seconds would be left
    const serverNow = skewPanelClock(30000);
    await openAsOwner({
      routes: {
        [arloPath('approvals')]: () => new Response(
          JSON.stringify({ approvals: [serverMessage.approval({ id: ID1, askedBy: 'Ben', expiresAt: serverNow() + 40000 }).data] }),
          { status: 200, headers: { 'Content-Type': 'application/json', Date: new Date(serverNow()).toUTCString() } },
        ),
      },
    });
    const left = countdown(await findSheet());
    expect(left).toBeGreaterThanOrEqual(38);
    expect(left).toBeLessThanOrEqual(41);
  });

  test('two requests keep the server\'s order whatever the panel\'s clock says', async () => {
    const serverNow = skewPanelClock(5 * MINUTES);
    await openAsOwner({
      routes: {
        [arloPath('approvals')]: () => json({
          approvals: [
            serverMessage.approval({ id: ID2, askedBy: 'Dee', expiresAt: serverNow() + 50000 }).data,
            serverMessage.approval({ id: ID1, askedBy: 'Ben', expiresAt: serverNow() + 20000 }).data,
          ],
        }),
      },
    });
    expect(within(await findSheet()).getByText('Ben asked to see them.')).toBeInTheDocument();
  });
});

describe('a participant asks the owner to share the notes', () => {
  const askButton = () => screen.queryByRole('button', { name: /^Ask (.+ )?to share notes with everyone$/ });
  const asked = { [`POST ${arloPath('notes-request')}`]: () => json({ id: ID1, expiresAt: Date.now() + 60000 }) };

  test('one quiet action with the owner\'s name; the click posts the request once and says so', async () => {
    const { fetchMock, sdk } = await openAsParticipant({ routes: asked });
    const button = await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' });
    expect(button).not.toHaveClass('btn-default');
    await userEvent.click(button);

    expect(await screen.findByText(ASKED)).toBeInTheDocument();
    expect(screen.getByText(ASKED).closest('[role="status"]')).not.toBeNull();
    expect(askButton()).not.toBeInTheDocument();
    expect(posted(fetchMock, 'notes-request')).toEqual([{}]);
    // the participant's panel posts nothing to the chat
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('without a usable owner name it is "Ask for the notes"', async () => {
    await openAsParticipant({ state: { ...ANA_BROUGHT_ARLO, ownerName: null } });
    expect(await screen.findByRole('button', { name: 'Ask to share notes with everyone' })).toBeInTheDocument();
  });

  test.each([
    ['approved', 'The notes are shared with everyone.'],
    ['declined', 'They chose not to share the notes right now.'],
    ['expired', 'No answer this time.'],
    ['failed', 'The notes couldn\'t be shared.'],
  ])('outcome %s reads "%s"', async (outcome, text) => {
    await openAsParticipant({ routes: asked });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    await screen.findByText(ASKED);
    // another request's outcome, and another meeting's, are not this one's
    await send(serverMessage.approvalClosed(ID2, outcome));
    await send(serverMessage.approvalClosed(ID1, outcome, 'ANOTHER-MEETING=='));
    expect(screen.getByText(ASKED)).toBeInTheDocument();

    await send(serverMessage.approvalClosed(ID1, outcome));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByText(text).closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByText(ASKED)).not.toBeInTheDocument();
    expect(askButton()).not.toBeInTheDocument();
  });

  test('an outcome the panel does not know changes nothing', async () => {
    await openAsParticipant({ routes: asked });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    await screen.findByText(ASKED);
    await send(serverMessage.approvalClosed(ID1, 'exploded'));
    expect(screen.getByText(ASKED)).toBeInTheDocument();
  });

  test('429 without words from the server: asked a moment ago, and the button stays away', async () => {
    await openAsParticipant({ routes: { [`POST ${arloPath('notes-request')}`]: () => json({ error: 'too_soon' }, 429) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    expect(await screen.findByText('You asked a moment ago. Give it a couple of minutes.')).toBeInTheDocument();
    expect(askButton()).not.toBeInTheDocument();
  });

  test('429 with a short message from the server: that message, as text', async () => {
    const words = 'Too many requests are waiting for <b>Ana</b>. Try again in a minute.';
    await openAsParticipant({ routes: { [`POST ${arloPath('notes-request')}`]: () => json({ error: 'too_many_open', message: words }, 429) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.queryByText('You asked a moment ago. Give it a couple of minutes.')).not.toBeInTheDocument();
    expect(askButton()).not.toBeInTheDocument();
  });

  test.each([
    ['longer than 200 characters', 'x'.repeat(201)],
    ['blank', '   '],
    ['not text', { text: 'server words' }],
  ])('429 with a message that is %s: the panel\'s own words', async (_name, message) => {
    await openAsParticipant({ routes: { [`POST ${arloPath('notes-request')}`]: () => json({ error: 'too_soon', message }, 429) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    expect(await screen.findByText('You asked a moment ago. Give it a couple of minutes.')).toBeInTheDocument();
    expect(screen.queryByText(/x{201}|server words/)).not.toBeInTheDocument();
  });

  test('409: Arlo is not taking notes for anyone, and the button is there again at once', async () => {
    const { fetchMock } = await openAsParticipant({ routes: { [`POST ${arloPath('notes-request')}`]: () => json({ error: 'no_owner' }, 409) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    expect(await screen.findByText('Arlo isn\'t taking notes for anyone right now.')).toBeInTheDocument();
    expect(askButton()).toBeEnabled();
    await userEvent.click(askButton());
    await waitFor(() => expect(posted(fetchMock, 'notes-request')).toHaveLength(2));
  });

  test('a request that cannot be sent says so, without the server\'s words', async () => {
    await openAsParticipant({ routes: { [`POST ${arloPath('notes-request')}`]: () => json({ error: 'boom', message: 'stack trace' }, 500) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    expect(await screen.findByText('Couldn\'t ask for the notes. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/stack trace/)).not.toBeInTheDocument();
    expect(askButton()).toBeEnabled();
  });

  test('after an outcome the button returns two minutes later, not before', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const { fetchMock } = await openAsParticipant({ routes: asked });
    await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(screen.getByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    await screen.findByText(ASKED);
    await send(serverMessage.approvalClosed(ID1, 'declined'));
    await screen.findByText('They chose not to share the notes right now.');

    await act(async () => { vi.advanceTimersByTime(119000); });
    expect(askButton()).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(askButton()).toBeInTheDocument();
    expect(screen.queryByText('They chose not to share the notes right now.')).not.toBeInTheDocument();
    expect(posted(fetchMock, 'notes-request')).toHaveLength(1);
  });

  test('a guest has no such button', async () => {
    await open({ sdk: attendee({ status: 'unauthenticated' }), guest: true, state: ANA_BROUGHT_ARLO, notes: null });
    await screen.findByRole('button', { name: 'Sign in to ask Arlo' });
    expect(askButton()).not.toBeInTheDocument();
  });

  test('not while Arlo is not in the meeting, and not after the meeting ended', async () => {
    await openAsParticipant({ routes: asked });
    await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' });
    await act(async () => {
      server().serverSend(serverMessage.status('rtms_stopped', { meetingEnded: true }));
      server().serverSend(serverMessage.arloState({ present: false, role: 'participant', ownerName: null }));
    });
    await screen.findByRole('heading', { name: 'Arlo isn\'t in this meeting' });
    expect(askButton()).not.toBeInTheDocument();
  });

  test('it does not depend on "Take notes yourself": shown without it, and above it when both show', async () => {
    await openAsParticipant();
    const ask = await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' });
    const use = screen.getByRole('button', { name: 'Take notes yourself' });
    expect(ask.compareDocumentPosition(use) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('shown when the deployment has "Take notes yourself" off', async () => {
    await openAsParticipant({ routes: { '/api/auth/settings': () => json({ demoMode: true, features: { autoStart: false } }) } });
    expect(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take notes yourself' })).not.toBeInTheDocument();
  });

  test('no name and no notes are logged', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    await openAsParticipant({ routes: asked });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    await send(serverMessage.approvalClosed(ID1, 'approved'));
    await screen.findByText('The notes are shared with everyone.');
    const logged = spies.flatMap((spy) => spy.mock.calls).flat().map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? '')).join('\n');
    expect(logged).not.toContain('Ana');
    expect(logged).not.toContain(ID1);
  });
});
