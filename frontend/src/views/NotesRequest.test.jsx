import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
  arloPath, ARLO_ABSENT,
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
  test('with the name of the person who asked, the focus on "Share notes", and the notes behind inert', async () => {
    await openAsOwner();
    expect(sheet()).not.toBeInTheDocument();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben Okafor' }));

    const dialog = await findSheet();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Ben Okafor asked to see them.')).toBeInTheDocument();
    const share = within(dialog).getByRole('button', { name: 'Share notes' });
    expect(share).toBeEnabled();
    expect(share).toHaveFocus();
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
    await userEvent.click(within(await findSheet()).getByRole('button', { name: 'Share notes' }));

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
    const dialog = await findSheet();
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
    await userEvent.click(within(await findSheet()).getByRole('button', { name: 'Share notes' }));

    expect(await screen.findByText('Couldn\'t share the notes. Try again.')).toBeInTheDocument();
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]);
    expect(screen.queryByText('Notes are now shared with everyone')).not.toBeInTheDocument();
    expect(screen.queryByText('server words')).not.toBeInTheDocument();
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
  });

  test('no notes yet: the owner can agree all the same, they are shared as they come', async () => {
    const { sdk, fetchMock } = await openAsOwner({ notes: null });
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await userEvent.click(within(await findSheet()).getByRole('button', { name: 'Share notes' }));

    expect(await screen.findByText('Notes are now shared with everyone')).toBeInTheDocument();
    await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: true }]));
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('"Not now" declines and posts nothing to the chat', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await userEvent.click(within(await findSheet()).getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([{ approve: false }]));
    await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('Escape is "Not now"', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await findSheet();
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
    const dialog = await findSheet();
    const share = within(dialog).getByRole('button', { name: 'Share notes' });
    const notNow = within(dialog).getByRole('button', { name: 'Not now' });
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

  test('it runs out by its own time, and is never answered for the owner', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben', expiresAt: Date.now() + 1200 }));
    await findSheet();
    await waitFor(() => expect(sheet()).not.toBeInTheDocument(), { timeout: 3000 });
    expect(posted(fetchMock, `approvals/${ID1}`)).toEqual([]);
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    // one that is already past its time is not shown at all
    await send(serverMessage.approval({ id: ID2, askedBy: 'Ben', expiresAt: Date.now() - 1 }));
    expect(sheet()).not.toBeInTheDocument();
  });

  test('two requests wait in line, oldest first; a repeated message is not a second request', async () => {
    const { fetchMock } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    await send(serverMessage.approval({ id: ID2, askedBy: 'Dee' }));
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben' }));
    expect(within(await findSheet()).getByText('Ben asked to see them.')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await screen.findByText('Dee asked to see them.');
    expect(screen.getByRole('button', { name: 'Share notes' })).toHaveFocus();
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
    expect(within(await findSheet()).getByText('Ben asked to see them.')).toBeInTheDocument();
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
    expect(fetchMock.mock.calls.some(([url]) => String(url) === arloPath('approvals'))).toBe(false);
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

  test('429: asked a moment ago, and the button stays away', async () => {
    await openAsParticipant({ routes: { [`POST ${arloPath('notes-request')}`]: () => json({ error: 'too_soon', message: 'server words' }, 429) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Ana to share notes with everyone' }));
    expect(await screen.findByText('You asked a moment ago. Give it a couple of minutes.')).toBeInTheDocument();
    expect(screen.queryByText('server words')).not.toBeInTheDocument();
    expect(askButton()).not.toBeInTheDocument();
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
