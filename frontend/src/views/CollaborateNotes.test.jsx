import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
  arloPath, ARLO_ABSENT, arloAction,
} from '../test/harness';

// Arlo's notes opened for everyone in Zoom's Collaborate mode: the button on
// the owner's notes screen, the action Arlo sends an owner's panel, and the
// document everyone sees while the app runs in Collaborate. Driven through
// the real app in a fake meeting.

const NOTES = {
  summary: 'The beta moves to March 3 so billing can finish first.',
  decisions: ['Beta launch moves to March 3'],
  actionItems: [{ text: 'Send the revised timeline', owner: 'Ana' }],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 9,
};
const OWNER = { present: true, role: 'owner', ownerName: 'Ana', myStreamLive: true };
const PARTICIPANT = { present: true, role: 'participant', ownerName: 'Ana', whoCanAsk: 'anyone', notesShared: true };
const OPEN = 'Open notes for everyone';
const WARNING = 'Everyone in the meeting will see your Arlo view.';
const CLOSE = 'Close for everyone';
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); });
const button = (name) => screen.queryByRole('button', { name });
const calls = (fetchMock, path, method = 'POST') => fetchMock.mock.calls
  .filter(([url, init]) => String(url).startsWith(arloPath(path)) && (init?.method || 'GET') === method);
const results = (fetchMock) => calls(fetchMock, 'actions/').map(([, init]) => JSON.parse(init.body));

async function open({ sdk = createZoomSdk(), guest = false, state = OWNER, notes = NOTES, routes = {} } = {}) {
  const fetchMock = mockFetch({
    [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }),
    [`POST ${arloPath('open-notes')}`]: () => json({ shared: true }),
    ...routes,
  }, { signedIn: !guest });
  const result = renderInMeeting({ sdk, guest });
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.subscribed());
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.arloState(state));
  if (notes) await send(serverMessage.notes(notes));
  return { ...result, sdk, fetchMock };
}
const inCollaborate = (options = {}) => createZoomSdk({ runningContext: 'inCollaborate', ...options });
/** Zoom moves this app instance into or out of Collaborate. */
const moveTo = (sdk, runningContext) => act(async () => {
  sdk.runningContext = runningContext;
  sdk.emit('onCollaborateChange', { action: 'x', timestamp: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHarness();
});

describe('"Open notes for everyone" on the owner\'s notes screen', () => {
  test('one click asks; "Open" shares the notes on the server and then starts Collaborate with the screen share', async () => {
    const user = userEvent.setup();
    const { sdk, fetchMock } = await open();
    await screen.findByText(NOTES.summary);
    await user.click(await screen.findByRole('button', { name: OPEN }));
    expect(screen.getByText(WARNING)).toBeInTheDocument();
    expect(sdk.startCollaborate).not.toHaveBeenCalled();
    expect(calls(fetchMock, 'open-notes')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(sdk.startCollaborate).toHaveBeenCalledTimes(1));
    expect(sdk.startCollaborate).toHaveBeenCalledWith({ shareScreen: true });
    const posted = calls(fetchMock, 'open-notes');
    expect(posted).toHaveLength(1);
    expect(posted[0][1]).toMatchObject({ method: 'POST', credentials: 'include', body: '{}' });
    expect(posted[0][1].headers['Content-Type']).toBe('application/json');
    // shared before Zoom was asked
    const order = fetchMock.mock.invocationCallOrder[fetchMock.mock.calls.indexOf(posted[0])];
    expect(order).toBeLessThan(sdk.startCollaborate.mock.invocationCallOrder[0]);
    // the question is gone and the button is back
    await waitFor(() => expect(button(OPEN)).toBeInTheDocument());
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    expect(sdk.sendAppInvitationToAllParticipants).not.toHaveBeenCalled();
  });

  test('"Cancel" and Escape ask nothing of the server or of Zoom', async () => {
    const user = userEvent.setup();
    const { sdk, fetchMock } = await open();
    await user.click(await screen.findByRole('button', { name: OPEN }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: OPEN }));
    await user.keyboard('{Escape}');
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    expect(button(OPEN)).toBeInTheDocument();
    expect(sdk.startCollaborate).not.toHaveBeenCalled();
    expect(calls(fetchMock, 'open-notes')).toHaveLength(0);
  });

  test('the server refuses: an error, and Zoom is not asked', async () => {
    const user = userEvent.setup();
    const { sdk } = await open({ routes: { [`POST ${arloPath('open-notes')}`]: () => json({ error: 'Forbidden' }, 403) } });
    await user.click(await screen.findByRole('button', { name: OPEN }));
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('Couldn\'t open the notes for everyone. Try again.')).toBeInTheDocument();
    expect(sdk.startCollaborate).not.toHaveBeenCalled();
    expect(button(OPEN)).toBeInTheDocument();
  });

  test('Zoom refuses: an error that says the notes stay shared, and sharing is not turned off', async () => {
    const user = userEvent.setup();
    const sdk = createZoomSdk();
    sdk.startCollaborate.mockImplementation(async () => { throw Object.assign(new Error('This app cannot support collaborate mode.'), { code: 10089 }); });
    const { fetchMock } = await open({ sdk });
    await user.click(await screen.findByRole('button', { name: OPEN }));
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('Couldn\'t open the notes for everyone. They are still shared with everyone who has Arlo open.')).toBeInTheDocument();
    expect(calls(fetchMock, 'settings', 'PUT')).toHaveLength(0);
    expect(sdk.endCollaborate).not.toHaveBeenCalled();
    expect(button(OPEN)).toBeInTheDocument();
  });

  test('disabled while it runs: a second click does not ask twice', async () => {
    const user = userEvent.setup();
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const { sdk, fetchMock } = await open({ routes: { [`POST ${arloPath('open-notes')}`]: async () => { await waiting; return json({ shared: true }); } } });
    await user.click(await screen.findByRole('button', { name: OPEN }));
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await act(async () => { release(); });
    await waitFor(() => expect(sdk.startCollaborate).toHaveBeenCalledTimes(1));
    expect(calls(fetchMock, 'open-notes')).toHaveLength(1);
  });

  test('not offered without notes, to a client without startCollaborate, or to someone who is not an owner', async () => {
    const first = await open({ notes: null });
    await screen.findByText('Arlo is in the meeting');
    await settle();
    expect(button(OPEN)).not.toBeInTheDocument();
    first.unmount();
    resetHarness();

    const second = await open({ sdk: createZoomSdk({ unsupportedApis: ['startCollaborate'] }) });
    await screen.findByText(NOTES.summary);
    await settle();
    expect(button(OPEN)).not.toBeInTheDocument();
    second.unmount();
    resetHarness();

    await open({ state: PARTICIPANT });
    await screen.findByText(NOTES.summary);
    await settle();
    expect(button(OPEN)).not.toBeInTheDocument();
  });
});

describe('Arlo asks the owner\'s panel to open the notes for everyone', () => {
  test('Collaborate starts with the screen share, and the panel reports that it did', async () => {
    const { sdk, fetchMock } = await open();
    await send(serverMessage.action({ actionId: A1, tool: 'open_notes_for_everyone', args: {} }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(sdk.startCollaborate).toHaveBeenCalledTimes(1);
    expect(sdk.startCollaborate).toHaveBeenCalledWith({ shareScreen: true });
    expect(sdk.sendAppInvitationToAllParticipants).not.toHaveBeenCalled();
    expect(results(fetchMock)[0]).toEqual({ ok: true });
  });

  test('Zoom refuses: the invitation goes out instead and the panel says so', async () => {
    const sdk = createZoomSdk();
    sdk.startCollaborate.mockImplementation(async () => { throw new Error('no'); });
    const { fetchMock } = await open({ sdk });
    await send(serverMessage.action({ actionId: A1, tool: 'open_notes_for_everyone', args: {} }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(sdk.sendAppInvitationToAllParticipants).toHaveBeenCalledTimes(1);
    expect(results(fetchMock)[0]).toEqual({ ok: false, code: 'fell_back_invite' });
  });

  test('Zoom refuses both: sdk_error', async () => {
    const sdk = createZoomSdk();
    sdk.startCollaborate.mockImplementation(async () => { throw new Error('no'); });
    sdk.sendAppInvitationToAllParticipants.mockImplementation(async () => { throw new Error('no'); });
    const { fetchMock } = await open({ sdk });
    await send(serverMessage.action({ actionId: A1, tool: 'open_notes_for_everyone', args: {} }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(results(fetchMock)[0]).toEqual({ ok: false, code: 'sdk_error' });
  });

  test('the panel announces the tool only when the client took startCollaborate', async () => {
    const lastHands = () => server().sent.filter((message) => message.type === 'arlo.hands').at(-1)?.payload;
    const first = await open();
    await waitFor(() => expect(lastHands()?.can).toContain('open_notes_for_everyone'));
    first.unmount();
    resetHarness();
    await open({ sdk: createZoomSdk({ unsupportedApis: ['startCollaborate'] }) });
    await waitFor(() => expect(lastHands()?.can).toContain('post_to_chat'));
    expect(lastHands().can).not.toContain('open_notes_for_everyone');
  });
});

describe('the notes as a document while the app runs in Collaborate', () => {
  const PRIVATE = arloAction({ id: 'act-private', tool: 'answer_from_meeting', label: 'Answered a question', channel: 'panel', isPublic: false });
  const PUBLIC = arloAction({ id: 'act-public', tool: 'post_to_chat', label: 'Posted to chat' });

  test('the owner\'s view is the one that is screen-shared: the notes, the status, "Close for everyone", and nothing private', async () => {
    const { fetchMock } = await open({
      sdk: inCollaborate(),
      state: { ...OWNER, notesShared: true },
      routes: { [arloPath('actions')]: () => json({ actions: [PRIVATE, PUBLIC] }) },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Meeting notes' })).toBeInTheDocument();
    expect(screen.getByText('Written by Arlo · updates as the meeting goes on')).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByText('Beta launch moves to March 3')).toBeInTheDocument();
    expect(screen.getByText('Send the revised timeline · Ana')).toBeInTheDocument();
    expect(screen.getByText('Arlo is in the meeting')).toBeInTheDocument();
    expect(button(CLOSE)).toBeInTheDocument();
    // what Arlo did for everyone is listed; what it answered the owner in private is not
    expect(await screen.findByText('Posted to chat')).toBeInTheDocument();
    expect(screen.queryByText('Answered a question')).not.toBeInTheDocument();
    // no Ask Arlo, no settings, no other actions
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/who can ask/i)).not.toBeInTheDocument();
    for (const name of ['Leave', 'Stop sharing', 'Share notes with everyone', 'Post notes to chat', OPEN, 'Change', 'Ask']) {
      expect(button(name)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: 'Meeting record' })).not.toBeInTheDocument();
    expect(calls(fetchMock, 'ask')).toHaveLength(0);
  });

  test('"Close for everyone" ends Collaborate and leaves sharing as it is; a failure is said', async () => {
    const user = userEvent.setup();
    const { sdk, fetchMock } = await open({ sdk: inCollaborate(), state: { ...OWNER, notesShared: true } });
    await user.click(await screen.findByRole('button', { name: CLOSE }));
    await waitFor(() => expect(sdk.endCollaborate).toHaveBeenCalledTimes(1));
    expect(sdk.endCollaborate).toHaveBeenCalledWith();
    expect(calls(fetchMock, 'settings', 'PUT')).toHaveLength(0);
    expect(sdk.leaveCollaborate).not.toHaveBeenCalled();

    sdk.endCollaborate.mockImplementation(async () => { throw new Error('You can only end collaboration.'); });
    await user.click(screen.getByRole('button', { name: CLOSE }));
    expect(await screen.findByText('Couldn\'t close the notes for everyone. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/only end collaboration/)).not.toBeInTheDocument();
    expect(calls(fetchMock, 'settings', 'PUT')).toHaveLength(0);
  });

  test('a request for the owner is still asked on the shared view, and can be answered', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await open({ sdk: inCollaborate(), state: { ...OWNER, notesShared: true } });
    await screen.findByRole('heading', { level: 1, name: 'Meeting notes' });
    await send(serverMessage.approval({
      id: A1, kind: 'agent_action', askedBy: 'Ben', askerVerified: false, channel: 'voice',
      question: 'Stop the timer?', primaryLabel: 'Stop timer',
    }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Stop the timer?')).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 760); }); });
    await user.click(within(sheet).getByRole('button', { name: 'Stop timer' }));
    await waitFor(() => expect(calls(fetchMock, `approvals/${A1}`)).toHaveLength(1));
  });

  test('a participant reads the same page: no asks, no choices, and "Leave"', async () => {
    const user = userEvent.setup();
    const { sdk } = await open({ sdk: inCollaborate({ role: 'attendee', screenName: 'Ben' }), state: PARTICIPANT });
    expect(await screen.findByRole('heading', { level: 1, name: 'Meeting notes' })).toBeInTheDocument();
    expect(screen.getByText('Written by Arlo · updates as the meeting goes on')).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    for (const name of [CLOSE, 'Take notes yourself', /Ask .*to share notes/, 'Pause', 'Remove Arlo', OPEN]) {
      expect(button(name)).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(sdk.leaveCollaborate).toHaveBeenCalledTimes(1));
    expect(sdk.endCollaborate).not.toHaveBeenCalled();

    sdk.leaveCollaborate.mockImplementation(async () => { throw new Error('no'); });
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Couldn\'t leave. Try again.')).toBeInTheDocument();
  });

  test('a guest reads it too, while the notes are shared', async () => {
    await open({ sdk: inCollaborate({ status: 'unauthenticated', role: 'attendee' }), guest: true, state: PARTICIPANT });
    expect(await screen.findByRole('heading', { level: 1, name: 'Meeting notes' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(button('Sign in to ask Arlo')).not.toBeInTheDocument();
  });

  test('before the first notes, for the owner and for a participant', async () => {
    const first = await open({ sdk: inCollaborate(), state: { ...OWNER, notesShared: true }, notes: null });
    await screen.findByRole('heading', { level: 1, name: 'Meeting notes' });
    expect(screen.getByText('Notes appear after the first minute or so.')).toBeInTheDocument();
    first.unmount();
    resetHarness();
    await open({ sdk: inCollaborate({ role: 'attendee' }), state: PARTICIPANT, notes: null });
    await screen.findByRole('heading', { level: 1, name: 'Meeting notes' });
    expect(screen.getByText('Notes appear after the first minute or so.')).toBeInTheDocument();
  });

  test('a participant whose owner does not share the notes sees none of them', async () => {
    await open({ sdk: inCollaborate({ role: 'attendee' }), state: { ...PARTICIPANT, notesShared: false } });
    await screen.findByRole('heading', { level: 1, name: 'Meeting notes' });
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.getByText('The notes are not shared right now.')).toBeInTheDocument();
  });

  test('Collaborate starts and ends under an open panel: the document, then the normal screen again', async () => {
    const { sdk } = await open();
    await screen.findByText(NOTES.summary);
    expect(screen.queryByRole('heading', { level: 1, name: 'Meeting notes' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    await moveTo(sdk, 'inCollaborate');
    expect(await screen.findByRole('heading', { level: 1, name: 'Meeting notes' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(button(CLOSE)).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();

    await moveTo(sdk, 'inMeeting');
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: 'Meeting notes' })).not.toBeInTheDocument());
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(button(CLOSE)).not.toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(button(OPEN)).toBeInTheDocument();
  });
});

describe('"Stop sharing" also closes the notes that were opened for everyone', () => {
  test('sharing is turned off on the server, then Collaborate is ended; Zoom\'s refusal is not an error', async () => {
    const user = userEvent.setup();
    const sdk = createZoomSdk();
    sdk.endCollaborate.mockImplementation(async () => { throw Object.assign(new Error('The app isn\'t in collaborate mode.'), { code: 10085 }); });
    const { fetchMock } = await open({ sdk, state: { ...OWNER, notesShared: true } });
    await user.click(await screen.findByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(sdk.endCollaborate).toHaveBeenCalledTimes(1));
    expect(JSON.parse(calls(fetchMock, 'settings', 'PUT')[0][1].body)).toEqual({ shareNotes: false });
    await settle();
    expect(screen.queryByText(/Couldn't/)).not.toBeInTheDocument();
  });

  test('turning sharing on, or a stop the server refused, ends nothing', async () => {
    const user = userEvent.setup();
    const first = await open();
    await user.click(await screen.findByRole('button', { name: 'Share notes with everyone' }));
    await waitFor(() => expect(calls(first.fetchMock, 'settings', 'PUT')).toHaveLength(1));
    await settle();
    expect(first.sdk.endCollaborate).not.toHaveBeenCalled();
    first.unmount();
    resetHarness();

    const second = await open({
      state: { ...OWNER, notesShared: true },
      routes: { [`PUT ${arloPath('settings')}`]: () => json({ error: 'Forbidden' }, 403) },
    });
    await user.click(await screen.findByRole('button', { name: 'Stop sharing' }));
    expect(await screen.findByText('Couldn\'t change sharing. Try again.')).toBeInTheDocument();
    expect(second.sdk.endCollaborate).not.toHaveBeenCalled();
  });
});
