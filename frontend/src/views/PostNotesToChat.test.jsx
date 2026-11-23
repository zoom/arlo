import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
  arloPath, ARLO_ABSENT,
} from '../test/harness';

// "Post notes to chat": the owner posts the current notes into the Zoom
// meeting chat, for everyone. Driven through the real app in a fake meeting.

const NOTES = {
  summary: 'The beta moves to March 3 so billing can finish first.',
  decisions: ['Beta launch moves to March 3', 'Keep the three-tier pricing'],
  actionItems: [
    { text: 'Send the revised timeline', owner: 'Ana' },
    { text: 'Draft the beta invite email', owner: null },
  ],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 9,
};
const MESSAGE = [
  'Notes from Arlo',
  '',
  'Summary',
  'The beta moves to March 3 so billing can finish first.',
  '',
  'Decisions',
  '- Beta launch moves to March 3',
  '- Keep the three-tier pricing',
  '',
  'Action items',
  '- Send the revised timeline · Ana',
  '- Draft the beta invite email',
].join('\n');
const OWNER = { present: true, role: 'owner', ownerName: 'Ana' };
const ANA_BROUGHT_ARLO = { present: true, role: 'participant', ownerName: 'Ana', whoCanAsk: 'anyone' };
const ACTION = 'Post notes to chat';
const QUESTION = 'Post these notes to everyone in the chat?';

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const action = () => screen.queryByRole('button', { name: ACTION });

async function open({ sdk, guest = false, state = OWNER, notes = NOTES } = {}) {
  mockFetch({ [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }) }, { signedIn: !guest });
  const result = renderInMeeting({ sdk, guest });
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.status('rtms_started'));
  if (notes) await send(serverMessage.notes(notes));
  return result;
}

/** The owner's notes screen, with notes on it. */
async function openAsOwner(options = {}) {
  const result = await open(options);
  await screen.findByText('Arlo is in the meeting');
  if (options.notes !== null) await screen.findByText((options.notes || NOTES).summary);
  return result;
}

/** A promise the test settles when it wants to. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHarness();
});

describe('who is offered "Post notes to chat"', () => {
  test('an owner with notes, as a quiet action next to the meeting record link', async () => {
    await openAsOwner();
    const button = await screen.findByRole('button', { name: ACTION });
    expect(button).toBeEnabled();
    expect(button.closest('.arlo-notes-actions')).toContainElement(screen.getByRole('link', { name: 'Meeting record' }));
    // The screen's main action stays the Ask input
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toBeInTheDocument();
    expect(button).not.toHaveClass('btn-default');
  });

  test('not a participant, who has no notes', async () => {
    await open({ sdk: createZoomSdk({ role: 'attendee', screenName: 'Ben' }), state: ANA_BROUGHT_ARLO });
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    await screen.findByRole('textbox', { name: 'Ask Arlo' });
    expect(action()).not.toBeInTheDocument();
  });

  test('not a guest', async () => {
    await open({ sdk: createZoomSdk({ role: 'attendee', status: 'unauthenticated' }), guest: true, state: ANA_BROUGHT_ARLO });
    await screen.findByRole('button', { name: 'Sign in to ask Arlo' });
    expect(action()).not.toBeInTheDocument();
  });

  test('not while there are no notes, or notes with nothing in them', async () => {
    await openAsOwner({ notes: null });
    await screen.findByText(/Arlo is listening/);
    expect(action()).not.toBeInTheDocument();

    await send(serverMessage.notes({ ...NOTES, summary: '', decisions: [], actionItems: [] }));
    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();
    expect(action()).not.toBeInTheDocument();

    await send(serverMessage.notes(NOTES));
    expect(await screen.findByRole('button', { name: ACTION })).toBeInTheDocument();
  });

  test('not after the meeting: the chat is gone, "Copy notes" stays', async () => {
    await openAsOwner();
    await screen.findByRole('button', { name: ACTION });
    await act(async () => {
      server().serverSend(serverMessage.status('rtms_stopped', { meetingEnded: true }));
      server().serverSend(serverMessage.arloState({ present: false, role: 'participant', ownerName: null }));
    });
    expect(await screen.findByRole('button', { name: 'Copy notes' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(action()).not.toBeInTheDocument();
  });

  test('not when the Zoom client has no sendMessageToChat', async () => {
    const sdk = createZoomSdk();
    delete sdk.sendMessageToChat;
    await openAsOwner({ sdk });
    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();
    expect(action()).not.toBeInTheDocument();
  });
});

describe('posting needs a confirmation: everyone sees it and it cannot be undone', () => {
  test('the first click sends nothing and asks, with the focus on "Post"', async () => {
    const { sdk } = await openAsOwner();
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));

    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(action()).not.toBeInTheDocument();
    const post = screen.getByRole('button', { name: 'Post' });
    expect(post).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByRole('group', { name: QUESTION })).toContainElement(post);
  });

  test('"Post" sends the notes once, as plain text', async () => {
    const { sdk } = await openAsOwner();
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    await screen.findByText('Notes posted to the chat');
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    expect(sdk.sendMessageToChat).toHaveBeenCalledWith({ message: MESSAGE });
  });

  test('the keyboard alone: Enter on the action, Enter on "Post"', async () => {
    const { sdk } = await openAsOwner();
    (await screen.findByRole('button', { name: ACTION })).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Post' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1));
  });

  test('"Cancel" sends nothing and gives the action back, with the focus', async () => {
    const { sdk } = await openAsOwner();
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: ACTION })).toHaveFocus();
  });

  test('Escape cancels, and sends nothing', async () => {
    const { sdk } = await openAsOwner();
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await userEvent.keyboard('{Escape}');

    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: ACTION })).toHaveFocus();
  });

  test('the question does not go away by itself while it is waiting for an answer', async () => {
    const { sdk } = await openAsOwner();
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    vi.useFakeTimers();
    await act(async () => { vi.advanceTimersByTime(60000); });
    vi.useRealTimers();

    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post' })).toHaveFocus();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('notes that arrive while the question is open are the ones posted', async () => {
    const { sdk } = await openAsOwner();
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await send(serverMessage.notes({ ...NOTES, summary: 'The beta moves to March 10.', decisions: [], actionItems: [] }));
    expect(screen.getByRole('button', { name: 'Post' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    await screen.findByText('Notes posted to the chat');
    expect(sdk.sendMessageToChat).toHaveBeenCalledWith({ message: 'Notes from Arlo\n\nSummary\nThe beta moves to March 10.' });
  });
});

describe('what happens after "Post"', () => {
  test('while Zoom has not answered, both buttons are disabled and a second click sends nothing', async () => {
    const answer = deferred();
    const sdk = createZoomSdk();
    sdk.sendMessageToChat = vi.fn(() => answer.promise);
    await openAsOwner({ sdk });
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);

    await act(async () => { answer.resolve({}); });
    expect(await screen.findByText('Posted to chat just now')).toBeInTheDocument();
  });

  test('success: the toast, and "Posted to chat just now" in place of the action', async () => {
    await openAsOwner();
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    expect(await screen.findByText('Notes posted to the chat')).toBeInTheDocument();
    expect(screen.getByText('Posted to chat just now')).toBeInTheDocument();
    expect(action()).not.toBeInTheDocument();
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();
  });

  test('the action returns 30 seconds after a post, not before', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const { sdk } = await openAsOwner();
    await screen.findByRole('button', { name: ACTION });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(screen.getByRole('button', { name: ACTION }));
    await user.click(screen.getByRole('button', { name: 'Post' }));
    await screen.findByText('Posted to chat just now');

    await act(async () => { vi.advanceTimersByTime(29000); });
    expect(screen.getByText('Posted to chat just now')).toBeInTheDocument();
    expect(action()).not.toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByText('Posted to chat just now')).not.toBeInTheDocument();
    expect(action()).toBeInTheDocument();
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
  });

  test('Zoom refuses (a rejected promise): the error toast, and the action again', async () => {
    const sdk = createZoomSdk();
    sdk.sendMessageToChat = vi.fn(async () => { throw Object.assign(new Error('Chat is disabled'), { code: '10089' }); });
    await openAsOwner({ sdk });
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    expect(await screen.findByText('Couldn\'t post to the chat. Try again.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: ACTION })).toBeEnabled();
    expect(screen.queryByText('Posted to chat just now')).not.toBeInTheDocument();
    expect(screen.queryByText('Notes posted to the chat')).not.toBeInTheDocument();
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();

    // And it can be tried again
    await userEvent.click(screen.getByRole('button', { name: ACTION }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(2));
  });

  test('an SDK that throws at once is the same failure', async () => {
    const sdk = createZoomSdk();
    sdk.sendMessageToChat = vi.fn(() => { throw new Error('not in a meeting'); });
    await openAsOwner({ sdk });
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    expect(await screen.findByText('Couldn\'t post to the chat. Try again.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: ACTION })).toBeEnabled();
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
  });

  test('the notes text is never logged, on success or on failure', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const sdk = createZoomSdk();
    sdk.sendMessageToChat = vi.fn()
      .mockImplementationOnce(async () => { throw new Error(`refused: ${MESSAGE}`); })
      .mockImplementationOnce(async () => ({}));
    await openAsOwner({ sdk });
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await screen.findByText('Couldn\'t post to the chat. Try again.');
    await userEvent.click(await screen.findByRole('button', { name: ACTION }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await screen.findByText('Notes posted to the chat');

    const logged = spies.flatMap((spy) => spy.mock.calls).map((args) => args.map((arg) => (
      arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg) ?? ''
    )).join(' ')).join('\n');
    expect(logged).not.toContain('March 3');
    expect(logged).not.toContain('three-tier');
    expect(logged).not.toContain('revised timeline');
  });
});
