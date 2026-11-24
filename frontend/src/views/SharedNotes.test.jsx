import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
  arloPath, ARLO_ABSENT,
} from '../test/harness';

// Sharing means the notes are live in everyone's Arlo panel. The owner turns
// it on and off; a participant or a guest sees the notes only while it is on.
// Driven through the real app in a fake meeting.

const NOTES = {
  summary: 'The beta moves to March 3 so billing can finish first.',
  decisions: ['Beta launch moves to March 3'],
  actionItems: [{ text: 'Send the revised timeline', owner: 'Ana' }],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 9,
};
const LATER = { ...NOTES, summary: 'Billing is done; the beta date holds.', throughSeqNo: 14 };
const OWNER = { present: true, role: 'owner', ownerName: 'Ana', myStreamLive: true };
const ANA_BROUGHT_ARLO = { present: true, role: 'participant', ownerName: 'Ana', whoCanAsk: 'owner' };
const SHARED = { ...ANA_BROUGHT_ARLO, notesShared: true };
const ID1 = '11111111-1111-4111-8111-111111111111';
const SHARE = 'Share notes with everyone';
const STOP = 'Stop sharing';
const IS_SHARED = 'Shared with everyone in the meeting';
const SHARING_HEADING = 'Ana is sharing Arlo\'s notes';
const ASK = 'Ask Ana to share notes with everyone';
const TAKE = 'Take notes yourself';
const ASKED = 'Asked. The notes appear here if they agree.';
const NOT_YET = 'Notes appear after the first minute or so.';

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const attendee = (extra = {}) => createZoomSdk({ role: 'attendee', screenName: 'Ben', ...extra });
const callsTo = (fetchMock, name, method = 'GET') => fetchMock.mock.calls
  .filter(([url, init]) => String(url) === arloPath(name) && (init?.method || 'GET') === method);
const bodies = (fetchMock, name, method) => callsTo(fetchMock, name, method).map(([, init]) => JSON.parse(init.body));

async function open({ sdk, guest = false, state = OWNER, notes = NOTES, routes = {} } = {}) {
  const fetchMock = mockFetch({ [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }), ...routes }, { signedIn: !guest });
  const result = renderInMeeting({ sdk, guest });
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.arloState(state));
  if (notes) await send(serverMessage.notes(notes));
  return { ...result, fetchMock };
}

/** The owner's panel. The settings route answers the way the server does: the caller's new state. */
async function openAsOwner({ state = OWNER, routes = {}, ...options } = {}) {
  let current = { ...ARLO_ABSENT, ...state };
  const result = await open({
    state,
    routes: {
      [`PUT ${arloPath('settings')}`]: ({ body }) => {
        current = { ...current, notesShared: body.shareNotes };
        return json(current);
      },
      ...routes,
    },
    ...options,
  });
  await screen.findByText('Arlo is in the meeting');
  await screen.findByText(NOTES.summary);
  return result;
}

async function openAsParticipant({ sdk = attendee(), state = ANA_BROUGHT_ARLO, notes = null, ...options } = {}) {
  const result = await open({ sdk, state, notes, ...options });
  await screen.findByRole('heading', { level: 1 });
  return result;
}

const openAsGuest = (options = {}) => openAsParticipant({ sdk: attendee({ status: 'unauthenticated' }), guest: true, ...options });

const expectNoOwnerControls = () => {
  for (const name of [SHARE, STOP, 'Post notes to chat', 'Change', 'Pause', 'Remove Arlo']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  expect(screen.queryByText(IS_SHARED)).not.toBeInTheDocument();
  expect(screen.queryByText(/^Who can ask/)).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHarness();
});

describe('the owner shares the notes with everyone, and stops', () => {
  test('one quiet button turns it on; the line says so and the button stops it again', async () => {
    const { fetchMock, sdk } = await openAsOwner();
    const share = screen.getByRole('button', { name: SHARE });
    expect(share).not.toHaveClass('btn-default');
    expect(screen.queryByText(IS_SHARED)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post notes to chat' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();

    await userEvent.click(share);
    expect(await screen.findByText(IS_SHARED)).toBeInTheDocument();
    expect(screen.getByText(IS_SHARED).closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: SHARE })).not.toBeInTheDocument();
    expect(bodies(fetchMock, 'settings', 'PUT')).toEqual([{ shareNotes: true }]);
    callsTo(fetchMock, 'settings', 'PUT').forEach(([, init]) => expect(init.credentials).toBe('include'));
    // no confirm step, and nothing goes to the chat
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    // "Post notes to chat" is still its own, one-time action
    expect(screen.getByRole('button', { name: 'Post notes to chat' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: STOP }));
    expect(await screen.findByRole('button', { name: SHARE })).toBeInTheDocument();
    expect(screen.queryByText(IS_SHARED)).not.toBeInTheDocument();
    expect(bodies(fetchMock, 'settings', 'PUT')).toEqual([{ shareNotes: true }, { shareNotes: false }]);
    // the notes never left the owner's screen
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
  });

  test('the button is disabled while the request is on its way', async () => {
    let release;
    const { fetchMock } = await openAsOwner({
      routes: { [`PUT ${arloPath('settings')}`]: () => new Promise((resolve) => { release = () => resolve(json({ ...ARLO_ABSENT, ...OWNER, notesShared: true })); }) },
    });
    await userEvent.click(screen.getByRole('button', { name: SHARE }));
    expect(screen.getByRole('button', { name: SHARE })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: SHARE }));
    expect(callsTo(fetchMock, 'settings', 'PUT')).toHaveLength(1);
    await act(async () => { release(); });
    expect(await screen.findByRole('button', { name: STOP })).toBeEnabled();
  });

  test.each([
    ['the server refuses', () => json({ error: 'Forbidden', message: 'server words' }, 403)],
    ['the request cannot be sent', () => { throw new Error('offline'); }],
  ])('%s: an error toast, and it reads as it was', async (_name, answer) => {
    await openAsOwner({ routes: { [`PUT ${arloPath('settings')}`]: answer } });
    await userEvent.click(screen.getByRole('button', { name: SHARE }));
    expect(await screen.findByText('Couldn\'t change sharing. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SHARE })).toBeEnabled();
    expect(screen.queryByText(IS_SHARED)).not.toBeInTheDocument();
    expect(screen.queryByText('server words')).not.toBeInTheDocument();
  });

  test('it shows what the server says: shared when the panel opens, and when another owner changes it', async () => {
    await openAsOwner({ state: { ...OWNER, notesShared: true } });
    expect(screen.getByText(IS_SHARED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: STOP })).toBeInTheDocument();
    await send(serverMessage.arloState({ ...OWNER, notesShared: false }));
    expect(screen.getByRole('button', { name: SHARE })).toBeInTheDocument();
    // another meeting's state is not this meeting's
    await send(serverMessage.arloState({ ...OWNER, notesShared: true }, 'ANOTHER-MEETING=='));
    expect(screen.getByRole('button', { name: SHARE })).toBeInTheDocument();
    await send(serverMessage.arloState({ ...OWNER, notesShared: true }));
    expect(screen.getByRole('button', { name: STOP })).toBeInTheDocument();
  });

  test('a guest on a notes screen has no such control', async () => {
    // What a panel is told is never enough: not signed in is never an owner
    await open({ sdk: attendee({ status: 'unauthenticated' }), guest: true, state: OWNER });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: SHARE })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: STOP })).not.toBeInTheDocument();
  });
});

describe('a participant sees the notes only while they are shared', () => {
  test('connected when sharing starts: the notes arrive, read-only, under who shares them', async () => {
    const { fetchMock } = await openAsParticipant({ routes: { [arloPath('notes')]: () => json({ notes: NOTES }) } });
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    expect(callsTo(fetchMock, 'notes')).toHaveLength(0);
    // notes that reach a panel they are not shared with are not kept
    await send(serverMessage.notes(NOTES));
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();

    await send(serverMessage.arloState(SHARED));
    expect(await screen.findByRole('heading', { name: SHARING_HEADING })).toBeInTheDocument();
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    expect(callsTo(fetchMock, 'notes')).toHaveLength(1);
    callsTo(fetchMock, 'notes').forEach(([, init]) => expect(init.credentials).toBe('include'));
    expect(screen.getByText('Beta launch moves to March 3')).toBeInTheDocument();
    expect(screen.getByText('Send the revised timeline · Ana')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();
    expectNoOwnerControls();

    // and they stay live
    await send(serverMessage.notes(LATER));
    expect(await screen.findByText(LATER.summary)).toBeInTheDocument();
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.queryByText(/The notes are shared with everyone/)).not.toBeInTheDocument();
  });

  test('opening the panel after sharing started reads them from the server', async () => {
    const { fetchMock } = await openAsParticipant({ state: SHARED, routes: { [arloPath('notes')]: () => json({ notes: NOTES }) } });
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: SHARING_HEADING })).toBeInTheDocument();
    expect(callsTo(fetchMock, 'notes').length).toBeGreaterThan(0);
    expectNoOwnerControls();
  });

  test('shared before there are notes: the heading and a line that they are coming', async () => {
    await openAsParticipant({ state: SHARED });
    expect(await screen.findByRole('heading', { name: SHARING_HEADING })).toBeInTheDocument();
    expect(screen.getByText(NOT_YET)).toBeInTheDocument();
    await send(serverMessage.notes(NOTES));
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.queryByText(NOT_YET)).not.toBeInTheDocument();
  });

  test('without a usable owner name the heading says it without one', async () => {
    await openAsParticipant({ state: { ...SHARED, ownerName: '   ' }, notes: NOTES });
    expect(await screen.findByRole('heading', { name: 'Arlo\'s notes are shared with everyone' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
  });

  test('the notes are gone the moment sharing stops, and later ones are not kept', async () => {
    const { fetchMock } = await openAsParticipant({ state: SHARED, notes: NOTES });
    await screen.findByText(NOTES.summary);
    const asked = callsTo(fetchMock, 'notes').length;

    await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: SHARING_HEADING })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ana brought Arlo into this meeting' })).toBeInTheDocument();
    await send(serverMessage.notes(LATER));
    expect(screen.queryByText(LATER.summary)).not.toBeInTheDocument();
    expect(callsTo(fetchMock, 'notes')).toHaveLength(asked);
    // the request is there again
    expect(screen.getByRole('button', { name: ASK })).toBeInTheDocument();

    // shared again: read again, never what was held before
    await send(serverMessage.arloState(SHARED));
    await waitFor(() => expect(callsTo(fetchMock, 'notes')).toHaveLength(asked + 1));
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.getByText(NOT_YET)).toBeInTheDocument();
  });

  test('the server refusing the notes shows none', async () => {
    await openAsParticipant({ state: SHARED, routes: { [arloPath('notes')]: () => json({ error: 'Forbidden' }, 403) } });
    expect(await screen.findByRole('heading', { name: SHARING_HEADING })).toBeInTheDocument();
    expect(screen.getByText(NOT_YET)).toBeInTheDocument();
  });

  test('another meeting\'s state and notes never render', async () => {
    await openAsParticipant();
    await send(serverMessage.arloState(SHARED, 'ANOTHER-MEETING=='));
    await send(serverMessage.notes(NOTES, 'ANOTHER-MEETING=='));
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ana brought Arlo into this meeting' })).toBeInTheDocument();
    // shared here: still only this meeting's notes
    await send(serverMessage.arloState(SHARED));
    await send(serverMessage.notes(LATER, 'ANOTHER-MEETING=='));
    await screen.findByRole('heading', { name: SHARING_HEADING });
    expect(screen.queryByText(LATER.summary)).not.toBeInTheDocument();
    await send(serverMessage.notes(NOTES));
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
  });

  test('the ask input follows the owner\'s setting, shared or not', async () => {
    await openAsParticipant({ state: SHARED, notes: NOTES });
    await screen.findByText(NOTES.summary);
    expect(screen.queryByRole('textbox', { name: 'Ask Arlo' })).not.toBeInTheDocument();
    expect(screen.getByText('Only people using Arlo can ask in this meeting.')).toBeInTheDocument();
    await send(serverMessage.arloState({ ...SHARED, whoCanAsk: 'anyone' }));
    expect(await screen.findByRole('textbox', { name: 'Ask Arlo' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
  });
});

describe('a guest sees shared notes too', () => {
  test('read-only, with "Sign in to ask Arlo" and neither of the two choices', async () => {
    const { fetchMock } = await openAsGuest({ state: SHARED, routes: { [arloPath('notes')]: () => json({ notes: NOTES }) } });
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: SHARING_HEADING })).toBeInTheDocument();
    expect(callsTo(fetchMock, 'notes').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Sign in to ask Arlo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /share notes with everyone$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TAKE })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Ask Arlo' })).not.toBeInTheDocument();
    expectNoOwnerControls();
  });

  test('not while they are not shared, and not after sharing stopped', async () => {
    await openAsGuest({ routes: { [arloPath('notes')]: () => json({ notes: NOTES }) } });
    await screen.findByRole('button', { name: 'Sign in to ask Arlo' });
    await send(serverMessage.notes(NOTES));
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    await send(serverMessage.arloState(SHARED));
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
  });
});

describe('the two choices of a signed-in participant', () => {
  test('both are there by default, of equal weight, each with one line that explains it', async () => {
    await openAsParticipant();
    const ask = await screen.findByRole('button', { name: ASK });
    const take = screen.getByRole('button', { name: TAKE });
    for (const button of [ask, take]) {
      expect(button).toHaveClass('btn-outline');
      expect(button).not.toHaveClass('btn-default');
    }
    expect(ask.className).toBe(take.className);
    expect(ask.compareDocumentPosition(take) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('They decide. If they agree, everyone with Arlo open sees the notes here.')).toBeInTheDocument();
    expect(screen.getByText('Starts Arlo for you too, under your own permission.')).toBeInTheDocument();
    // the old names are gone
    expect(screen.queryByRole('button', { name: 'Use Arlo yourself' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /for the notes$/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Use Arlo yourself/)).not.toBeInTheDocument();
  });

  test('without a usable owner name the request is "Ask to share notes with everyone"', async () => {
    await openAsParticipant({ state: { ...ANA_BROUGHT_ARLO, ownerName: null } });
    expect(await screen.findByRole('button', { name: 'Ask to share notes with everyone' })).toBeInTheDocument();
  });

  test('while the notes are shared the request is hidden; taking notes yourself stays', async () => {
    await openAsParticipant({ state: SHARED, notes: NOTES });
    await screen.findByText(NOTES.summary);
    expect(screen.queryByRole('button', { name: ASK })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: TAKE })).toBeInTheDocument();
  });

  test('"Take notes yourself" follows the deployment\'s setting, as before', async () => {
    await openAsParticipant({ routes: { '/api/auth/settings': () => json({ demoMode: true, features: { autoStart: false } }) } });
    expect(await screen.findByRole('button', { name: ASK })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TAKE })).not.toBeInTheDocument();
  });

  test('"Take notes yourself" asks for a stream of their own', async () => {
    const { sdk } = await openAsParticipant();
    await userEvent.click(await screen.findByRole('button', { name: TAKE }));
    await waitFor(() => expect(sdk.startRTMS).toHaveBeenCalledTimes(1));
  });
});

describe('asking the owner to share, end to end', () => {
  const asked = { [`POST ${arloPath('notes-request')}`]: () => json({ id: ID1, expiresAt: Date.now() + 60000 }) };

  test('the owner agrees: the notes appear in the panel of the person who asked', async () => {
    const { fetchMock, sdk } = await openAsParticipant({ routes: { ...asked, [arloPath('notes')]: () => json({ notes: NOTES }) } });
    await userEvent.click(await screen.findByRole('button', { name: ASK }));
    expect(await screen.findByText(ASKED)).toBeInTheDocument();
    expect(screen.getByText(ASKED).closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: ASK })).not.toBeInTheDocument();
    expect(bodies(fetchMock, 'notes-request', 'POST')).toEqual([{}]);

    // what the server sends when the owner agrees
    await send(serverMessage.arloState(SHARED));
    await send(serverMessage.approvalClosed(ID1, 'approved'));
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: SHARING_HEADING })).toBeInTheDocument();
    expect(screen.queryByText(ASKED)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ASK })).not.toBeInTheDocument();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expectNoOwnerControls();
  });

  test('told "approved" before the state arrived: it says so, and reads the state', async () => {
    let shared = false;
    const { fetchMock } = await openAsParticipant({
      routes: {
        ...asked,
        [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...(shared ? SHARED : ANA_BROUGHT_ARLO) }),
        [arloPath('notes')]: () => json({ notes: NOTES }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: ASK }));
    await screen.findByText(ASKED);
    const stateAsked = callsTo(fetchMock, 'state').length;
    shared = true;
    await send(serverMessage.approvalClosed(ID1, 'approved'));
    await waitFor(() => expect(callsTo(fetchMock, 'state').length).toBeGreaterThan(stateAsked));
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
  });

  test.each([
    ['declined', 'They chose not to share the notes right now.'],
    ['expired', 'No answer this time.'],
    ['failed', 'The notes couldn\'t be shared.'],
  ])('outcome %s reads "%s", and no notes appear', async (outcome, text) => {
    await openAsParticipant({ routes: asked });
    await userEvent.click(await screen.findByRole('button', { name: ASK }));
    await screen.findByText(ASKED);
    await send(serverMessage.approvalClosed(ID1, outcome, 'ANOTHER-MEETING=='));
    expect(screen.getByText(ASKED)).toBeInTheDocument();
    await send(serverMessage.approvalClosed(ID1, outcome));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByText(text).closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByText(ASKED)).not.toBeInTheDocument();
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: SHARING_HEADING })).not.toBeInTheDocument();
    // the other choice is still there
    expect(screen.getByRole('button', { name: TAKE })).toBeInTheDocument();
  });

  test('shared already (409): no message, the panel reads the state and the notes show', async () => {
    let shared = false;
    const { fetchMock } = await openAsParticipant({
      routes: {
        [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...(shared ? SHARED : ANA_BROUGHT_ARLO) }),
        [arloPath('notes')]: () => json({ notes: NOTES }),
        [`POST ${arloPath('notes-request')}`]: () => { shared = true; return json({ error: 'already_shared', message: 'server words' }, 409); },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: ASK }));
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.queryByText('server words')).not.toBeInTheDocument();
    expect(screen.queryByText('Arlo isn\'t taking notes for anyone right now.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ASK })).not.toBeInTheDocument();
    expect(bodies(fetchMock, 'notes-request', 'POST')).toEqual([{}]);
  });

  test('after sharing stopped again, no line from the old request is left', async () => {
    await openAsParticipant({ routes: { ...asked, [arloPath('notes')]: () => json({ notes: NOTES }) } });
    await userEvent.click(await screen.findByRole('button', { name: ASK }));
    await screen.findByText(ASKED);
    await send(serverMessage.approvalClosed(ID1, 'approved'));
    await send(serverMessage.arloState(SHARED));
    await screen.findByText(NOTES.summary);
    await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.queryByText(/The notes are shared with everyone/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: ASK })).toBeInTheDocument();
  });
});

describe('the owner is asked to share with everyone', () => {
  const QUESTION = 'Share the notes with everyone in the meeting?';

  test('agreeing reports { approve: true } and posts nothing to the chat; the server does the sharing', async () => {
    const { fetchMock, sdk } = await openAsOwner();
    await send(serverMessage.approval({ id: ID1, askedBy: 'Ben Okafor' }));
    const dialog = await screen.findByRole('dialog', { name: QUESTION });
    expect(within(dialog).getByText('Ben Okafor asked to see them.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share notes' }));

    expect(await screen.findByText('Notes are now shared with everyone')).toBeInTheDocument();
    expect(bodies(fetchMock, `approvals/${ID1}`, 'POST')).toEqual([{ approve: true }]);
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // what the server then tells every panel
    await send(serverMessage.arloState({ ...OWNER, notesShared: true }));
    expect(screen.getByText(IS_SHARED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: STOP })).toBeInTheDocument();
  });

  test('a Zoom client that cannot post to the chat can still share', async () => {
    const sdk = createZoomSdk();
    delete sdk.sendMessageToChat;
    const { fetchMock } = await openAsOwner({ sdk });
    await send(serverMessage.approval({ id: ID1, askedBy: null }));
    const dialog = await screen.findByRole('dialog', { name: QUESTION });
    expect(within(dialog).getByText('Someone in the meeting asked to see them.')).toBeInTheDocument();
    expect(screen.queryByText('This Zoom client can\'t post to the chat.')).not.toBeInTheDocument();
    const share = within(dialog).getByRole('button', { name: 'Share notes' });
    expect(share).toBeEnabled();
    expect(share).toHaveFocus();
    await userEvent.click(share);
    await waitFor(() => expect(bodies(fetchMock, `approvals/${ID1}`, 'POST')).toEqual([{ approve: true }]));
  });
});

describe('after the meeting', () => {
  const endMeeting = () => act(async () => {
    server().serverSend(serverMessage.status('rtms_stopped', { meetingEnded: true }));
    // the meeting's data is deleted: nobody owns it and nothing is shared
    server().serverSend(serverMessage.arloState({ present: false, role: 'participant', ownerName: null, notesShared: false }));
  });

  test('a participant who was reading shared notes keeps them, with "Copy notes" and the demo line', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await openAsParticipant({ state: SHARED, notes: NOTES });
    await screen.findByText(NOTES.summary);
    await endMeeting();

    expect(await screen.findByRole('heading', { name: 'Notes from this meeting' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByText('Demo mode: meetings and notes are not stored.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TAKE })).not.toBeInTheDocument();
    expectNoOwnerControls();
    await userEvent.click(screen.getByRole('button', { name: 'Copy notes' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain(NOTES.summary);
  });

  test('a participant the notes were not shared with has none', async () => {
    await openAsParticipant();
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    await endMeeting();
    expect(await screen.findByRole('heading', { name: 'Arlo isn\'t in this meeting' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy notes' })).not.toBeInTheDocument();
  });

  test('one whose sharing had stopped before the end has none either', async () => {
    await openAsParticipant({ state: SHARED, notes: NOTES });
    await screen.findByText(NOTES.summary);
    await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
    await endMeeting();
    expect(await screen.findByRole('heading', { name: 'Arlo isn\'t in this meeting' })).toBeInTheDocument();
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
  });

  test('the panel moving to another meeting drops them', async () => {
    const { sdk } = await openAsParticipant({ state: SHARED, notes: NOTES });
    await screen.findByText(NOTES.summary);
    await endMeeting();
    await screen.findByRole('heading', { name: 'Notes from this meeting' });

    sdk.getMeetingUUID.mockImplementation(async () => ({ meetingUUID: 'MEETING-2==' }));
    await act(async () => { sdk.emit('onRunningContextChange', { runningContext: 'inMainClient' }); });
    await act(async () => { sdk.emit('onRunningContextChange', { runningContext: 'inMeeting' }); });
    await waitFor(() => expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Notes from this meeting' })).not.toBeInTheDocument();
  });
});

test('no notes and no names are logged', async () => {
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  await openAsParticipant({ routes: { [arloPath('notes')]: () => json({ notes: NOTES }) } });
  await send(serverMessage.arloState(SHARED));
  await screen.findByText(NOTES.summary);
  await send(serverMessage.notes(LATER));
  await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
  const logged = spies.flatMap((spy) => spy.mock.calls).flat().map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? '')).join('\n');
  expect(logged).not.toContain('Ana');
  expect(logged).not.toContain('March 3');
  expect(logged).not.toContain('Billing');
});
