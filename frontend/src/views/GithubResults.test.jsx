import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage, serverMessagesFor,
  arloPath, ARLO_ABSENT,
} from '../test/harness';

// What Arlo found or did on GitHub, on the owner's notes screen: from the
// answer to their own typed request (`result` of POST …/ask) or from
// `arlo.result` after they approved one. Driven through the real app in a
// fake meeting. Also: the approval sheet for creating an issue.

const REPO = 'acme/arlo-app';
const OWNER = { present: true, role: 'owner', ownerName: 'Ana', myStreamLive: true };
const PARTICIPANT = { present: true, role: 'participant', ownerName: 'Ana', whoCanAsk: 'anyone', notesShared: true };
const NOTES = { summary: 'The beta moves to March 3.', decisions: [], actionItems: [], updatedAt: '2026-11-23T12:00:00.000Z', throughSeqNo: 9 };
const LIST = {
  kind: 'github_issues',
  repo: REPO,
  total: 2,
  issues: [
    { number: 12, title: 'Login fails on Safari', labels: ['bug', 'p1'], updatedAt: '2026-11-26T10:00:00Z' },
    { number: 7, title: 'Add dark mode', labels: [], updatedAt: '2026-11-20T10:00:00Z' },
  ],
};
const ISSUE = { kind: 'github_issue', repo: REPO, issue: { number: 12, title: 'Login fails on Safari', state: 'open', body: 'Steps:\n1. Open the page\n2. Click "Sign in"' } };
const CREATED = { kind: 'github_issue_created', repo: REPO, number: 31, title: 'Write the release notes' };
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';

// A stylesheet as written (the tests run without CSS): from the frontend workspace, where the tests are run
const cssOf = (path) => readFileSync(resolve(path), 'utf8');
const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); });
const result = (value, meetingId) => ({ type: 'arlo.result', data: { meetingId: meetingId ?? 'MEETING-1==', actionId: A1, result: value } });
const card = () => screen.queryByRole('region', { name: 'From GitHub' });

async function open({
  sdk = createZoomSdk(), guest = false, state = OWNER, routes = {}, repo = REPO, page = null,
} = {}) {
  const fetchMock = mockFetch({
    '/api/auth/settings': () => json({ demoMode: true, features: { autoStart: true, ownStream: true, github: { repo } } }),
    [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }),
    ...routes,
  }, { signedIn: !guest });
  const rendered = renderInMeeting({ sdk, guest, page });
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.subscribed());
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.arloState(state));
  await send(serverMessage.notes(NOTES));
  return { ...rendered, sdk, fetchMock };
}
async function openAsOwner(options = {}) {
  const opened = await open(options);
  await screen.findByText('Arlo is in the meeting');
  await screen.findByRole('textbox', { name: 'Ask Arlo' });
  return opened;
}
const askRoute = (answer) => ({ [`POST ${arloPath('ask')}`]: () => json(answer) });
async function ask(text = 'what are the open issues') {
  await userEvent.type(screen.getByRole('textbox', { name: 'Ask Arlo' }), text);
  await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHarness();
});

describe('a list of issues', () => {
  test('from the answer to the owner\'s own request: heading, rows, labels as text', async () => {
    await openAsOwner({ routes: askRoute({ answer: 'There are 2 open issues.', result: LIST }) });
    await ask();

    const region = await screen.findByRole('region', { name: 'From GitHub' });
    expect(within(region).getByRole('heading', { name: 'Open issues in acme/arlo-app' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: '#12 Login fails on Safari' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: '#7 Add dark mode' })).toBeInTheDocument();
    expect(within(region).getByText('bug · p1')).toBeInTheDocument();
    expect(within(region).queryByText(/more$/)).not.toBeInTheDocument();
    expect(within(region).getByText('Only you see this.')).toBeInTheDocument();
    // The answer is there as before
    expect(screen.getByText('There are 2 open issues.')).toBeInTheDocument();
  });

  test('from "arlo.result", after this owner approved a request', async () => {
    await openAsOwner();
    expect(card()).not.toBeInTheDocument();
    await send(result(LIST));
    expect(await screen.findByRole('heading', { name: 'Open issues in acme/arlo-app' })).toBeInTheDocument();
  });

  test('"… and k more" when there are more than the rows', async () => {
    await openAsOwner();
    await send(result({ ...LIST, total: 23 }));
    expect(await screen.findByText('… and 21 more')).toBeInTheDocument();
  });

  test('none open: one sentence, and nothing to post', async () => {
    await openAsOwner();
    await send(result({ ...LIST, total: 0, issues: [] }));
    expect(await screen.findByText('No open issues in acme/arlo-app.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post to chat' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  test('a row opens the issue at the link the panel builds, with Zoom', async () => {
    const { sdk } = await openAsOwner();
    // A URL the server adds is not used
    await send(result({ ...LIST, issues: [{ ...LIST.issues[0], url: 'https://evil.example/x', html_url: 'https://evil.example/y' }], total: 1 }));
    await userEvent.click(await screen.findByRole('button', { name: '#12 Login fails on Safari' }));

    await waitFor(() => expect(sdk.openUrl).toHaveBeenCalledTimes(1));
    expect(sdk.openUrl).toHaveBeenCalledWith({ url: 'https://github.com/acme/arlo-app/issues/12' });
  });

  test('Zoom refuses to open it: an error toast', async () => {
    const sdk = createZoomSdk();
    sdk.openUrl = vi.fn(async () => { throw new Error('10015'); });
    await openAsOwner({ sdk });
    await send(result(LIST));
    await userEvent.click(await screen.findByRole('button', { name: '#7 Add dark mode' }));
    expect(await screen.findByText('Zoom could not open the browser.')).toBeInTheDocument();
  });
});

describe('one issue, and a created issue', () => {
  test('one issue: number and title, state, the body as plain text with its lines', async () => {
    await openAsOwner();
    await send(result(ISSUE));
    const region = await screen.findByRole('region', { name: 'From GitHub' });
    expect(within(region).getByRole('button', { name: '#12 Login fails on Safari' })).toBeInTheDocument();
    expect(within(region).getByText('Open')).toBeInTheDocument();
    const body = region.querySelector('.arlo-github-body');
    expect(body.textContent).toBe('Steps:\n1. Open the page\n2. Click "Sign in"');
    expect(body.children).toHaveLength(0);
    const css = cssOf('src/views/ArloMeetingView.css');
    expect(css).toMatch(/\.arlo-github-body \{[^}]*white-space: pre-wrap;/);
  });

  test('a created issue: "Created issue #n: title" with the same link', async () => {
    const { sdk } = await openAsOwner({ routes: askRoute({ answer: 'Done: created issue 31.', result: CREATED }) });
    await ask('create an issue: Write the release notes');
    const region = await screen.findByRole('region', { name: 'From GitHub' });
    expect(region.querySelector('.arlo-github-created').textContent).toBe('Created issue #31 Write the release notes');
    expect(within(region).queryByRole('button', { name: 'Post to chat' })).not.toBeInTheDocument();
    await userEvent.click(within(region).getByRole('button', { name: '#31 Write the release notes' }));
    await waitFor(() => expect(sdk.openUrl).toHaveBeenCalledWith({ url: 'https://github.com/acme/arlo-app/issues/31' }));
  });
});

describe('everything from GitHub is untrusted', () => {
  test('HTML and script in a title, a label and a body are rendered as text', async () => {
    await openAsOwner();
    const title = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
    await send(result({ ...LIST, total: 1, issues: [{ number: 5, title, labels: ['<b>bold</b>'] }] }));
    const region = await screen.findByRole('region', { name: 'From GitHub' });
    expect(within(region).getByRole('button', { name: `#5 ${title}` })).toBeInTheDocument();
    expect(within(region).getByText('<b>bold</b>')).toBeInTheDocument();
    expect(region.querySelector('img, script, b')).toBeNull();
    expect(window.pwned).toBeUndefined();

    await send(result({ ...ISSUE, issue: { ...ISSUE.issue, body: '<script>window.pwned=3</script><a href="https://evil.example">x</a>' } }));
    await waitFor(() => expect(region.querySelector('.arlo-github-body')).not.toBeNull());
    expect(region.querySelector('script, a')).toBeNull();
    expect(window.pwned).toBeUndefined();
  });

  test('control and invisible characters are gone, and a 10 000-character title is cut', async () => {
    await openAsOwner();
    await send(result({ ...LIST, total: 2, issues: [{ number: 5, title: 'Fix\u0000 the‮ login\u0007', labels: [] }, { number: 6, title: 'a'.repeat(10000), labels: [] }] }));
    expect(await screen.findByRole('button', { name: '#5 Fix the login' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `#6 ${'a'.repeat(199)}…` })).toBeInTheDocument();
  });

  test.each([
    ['another repository than the server\'s', { ...LIST, repo: 'evil/arlo-app' }],
    ['a repository that is a path', { ...LIST, repo: 'acme/arlo-app/../../evil' }],
    ['a number as text', { ...LIST, issues: [{ number: '12', title: 'x', labels: [] }], total: 1 }],
    ['a number that is a fraction', { ...CREATED, number: 3.5 }],
    ['a number that is too large', { ...CREATED, number: 10000000 }],
    ['another kind', { ...LIST, kind: 'github_pull_requests' }],
    ['a kind with HTML', { kind: '<script>', repo: REPO }],
    ['text', 'Open issues in acme/arlo-app'],
    ['nothing', null],
  ])('%s: no result is shown', async (_name, value) => {
    await openAsOwner();
    await send(result(value));
    await settle();
    expect(card()).not.toBeInTheDocument();
  });

  test('a result that is none leaves the one on screen', async () => {
    await openAsOwner();
    await send(result(LIST));
    await screen.findByRole('heading', { name: 'Open issues in acme/arlo-app' });
    await send(result({ ...ISSUE, repo: 'evil/arlo-app' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Open issues in acme/arlo-app' })).toBeInTheDocument();
  });

  test('a result for another meeting is not this panel\'s', async () => {
    await openAsOwner();
    await send(result(LIST, 'OTHER-MEETING=='));
    await settle();
    expect(card()).not.toBeInTheDocument();
  });
});

describe('"Post to chat" under a result', () => {
  const issues = Array.from({ length: 8 }, (_, i) => ({ number: i + 1, title: i === 0 ? 'x'.repeat(120) : `Issue ${i + 1}`, labels: ['bug'] }));

  test('the first click only asks; "Post" sends one message built by the panel', async () => {
    const { sdk } = await openAsOwner();
    await send(result({ ...LIST, total: 23, issues }));
    const region = await screen.findByRole('region', { name: 'From GitHub' });
    await userEvent.click(within(region).getByRole('button', { name: 'Post to chat' }));

    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(within(region).getByRole('group', { name: 'Post this to everyone in the chat?' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Post' })).toHaveFocus();
    await userEvent.click(within(region).getByRole('button', { name: 'Post' }));

    await screen.findByText('Posted to the chat');
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    expect(sdk.sendMessageToChat).toHaveBeenCalledWith({
      message: [
        'Open issues in acme/arlo-app:',
        `#1 ${'x'.repeat(79)}…`,
        '#2 Issue 2',
        '#3 Issue 3',
        '#4 Issue 4',
        '#5 Issue 5',
        '… and 18 more',
      ].join('\n'),
    });
    expect(within(region).getByText('Posted to chat just now')).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Post to chat' })).not.toBeInTheDocument();
  });

  test('"Cancel" and Escape send nothing', async () => {
    const { sdk } = await openAsOwner();
    await send(result(LIST));
    await userEvent.click(await screen.findByRole('button', { name: 'Post to chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Post to chat' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Post to chat' })).toBeInTheDocument();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('one issue: its number and title, and the link', async () => {
    const { sdk } = await openAsOwner();
    await send(result(ISSUE));
    await userEvent.click(await screen.findByRole('button', { name: 'Post to chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(sdk.sendMessageToChat).toHaveBeenCalledWith({
      message: '#12 Login fails on Safari\nhttps://github.com/acme/arlo-app/issues/12',
    }));
  });

  test('Zoom refuses: the error toast, and it can be tried again', async () => {
    const sdk = createZoomSdk();
    sdk.sendMessageToChat = vi.fn(async () => { throw new Error('Chat is disabled'); });
    await openAsOwner({ sdk });
    await send(result(LIST));
    await userEvent.click(await screen.findByRole('button', { name: 'Post to chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByText('Couldn\'t post to the chat. Try again.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Post to chat' })).toBeEnabled();
  });

  test('not offered when the Zoom client has no sendMessageToChat', async () => {
    const sdk = createZoomSdk();
    delete sdk.sendMessageToChat;
    await openAsOwner({ sdk });
    await send(result(LIST));
    await screen.findByRole('heading', { name: 'Open issues in acme/arlo-app' });
    expect(screen.queryByRole('button', { name: 'Post to chat' })).not.toBeInTheDocument();
  });
});

describe('how long a result stays', () => {
  test('"Close" takes it away', async () => {
    await openAsOwner();
    await send(result(LIST));
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(card()).not.toBeInTheDocument();
  });

  test('a new result replaces the old one', async () => {
    await openAsOwner();
    await send(result(LIST));
    await screen.findByRole('heading', { name: 'Open issues in acme/arlo-app' });
    await send(result(CREATED));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Open issues in acme/arlo-app' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '#31 Write the release notes' })).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'From GitHub' })).toHaveLength(1);
  });

  test('gone when the meeting ends: not on the "after the meeting" screen', async () => {
    await openAsOwner();
    await send(result(LIST));
    await screen.findByRole('heading', { name: 'Open issues in acme/arlo-app' });
    await act(async () => {
      server().serverSend(serverMessage.status('rtms_stopped', { meetingEnded: true }));
      server().serverSend(serverMessage.arloState({ present: false, role: 'participant', ownerName: null }));
    });
    expect(await screen.findByRole('button', { name: 'Copy notes' })).toBeInTheDocument();
    expect(card()).not.toBeInTheDocument();
    expect(screen.queryByText(/Login fails on Safari/)).not.toBeInTheDocument();
  });

  test('gone when the panel moves to another meeting', async () => {
    const OTHER = 'MEETING-2==';
    const { sdk } = await openAsOwner({
      routes: { [arloPath('state', OTHER)]: () => json({ ...ARLO_ABSENT, ...OWNER }) },
    });
    await send(result(LIST));
    await screen.findByRole('heading', { name: 'Open issues in acme/arlo-app' });

    sdk.getMeetingUUID.mockImplementation(async () => ({ meetingUUID: OTHER }));
    await act(async () => { sdk.emit('onRunningContextChange', { runningContext: 'inMeeting' }); });
    await waitFor(() => expect(card()).not.toBeInTheDocument());
    await settle();
    // And nothing of it comes back in the other meeting
    const other = serverMessagesFor(OTHER);
    if (server()?.readyState === FakeWebSocket.OPEN) {
      await send(other.subscribed());
      await send(other.arloState(OWNER));
    }
    await settle();
    expect(screen.queryByText(/Login fails on Safari/)).not.toBeInTheDocument();
  });
});

describe('private to the owner', () => {
  test('never in the Collaborate view, which is on everyone\'s screen', async () => {
    const sdk = createZoomSdk({ runningContext: 'inCollaborate' });
    await open({ sdk, state: { ...OWNER, notesShared: true } });
    await screen.findByRole('heading', { name: 'Meeting notes' });
    await send(result(LIST));
    await send(result(ISSUE));
    await settle();
    expect(card()).not.toBeInTheDocument();
    expect(screen.queryByText(/Login fails on Safari/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open issues in/)).not.toBeInTheDocument();
  });

  test('a result on the notes screen is off the page when Collaborate starts', async () => {
    const { sdk } = await openAsOwner({ state: { ...OWNER, notesShared: true } });
    await send(result(LIST));
    await screen.findByRole('heading', { name: 'Open issues in acme/arlo-app' });
    await act(async () => {
      sdk.runningContext = 'inCollaborate';
      sdk.emit('onCollaborateChange', { action: 'x', timestamp: 1 });
    });
    await screen.findByRole('heading', { name: 'Meeting notes' });
    expect(card()).not.toBeInTheDocument();
    expect(screen.queryByText(/Login fails on Safari/)).not.toBeInTheDocument();
  });

  test('never in the participant view: not from "arlo.result", not from an answer', async () => {
    await open({
      sdk: createZoomSdk({ role: 'attendee', screenName: 'Ben' }),
      state: PARTICIPANT,
      routes: askRoute({ answer: 'There are 2 open issues.', result: LIST }),
    });
    await screen.findByRole('textbox', { name: 'Ask Arlo' });
    await send(result(LIST));
    await ask();
    await screen.findByText('There are 2 open issues.');
    expect(card()).not.toBeInTheDocument();
    expect(screen.queryByText(/Login fails on Safari/)).not.toBeInTheDocument();
  });

  test('never for a guest', async () => {
    await open({ sdk: createZoomSdk({ role: 'attendee', status: 'unauthenticated' }), guest: true, state: PARTICIPANT });
    await screen.findByRole('button', { name: 'Sign in to ask Arlo' });
    await send(result(LIST));
    await settle();
    expect(card()).not.toBeInTheDocument();
  });

  test('never in the meeting record', async () => {
    await open({ page: 'record' });
    await screen.findByRole('heading', { name: /record/i });
    await send(result(LIST));
    await settle();
    expect(card()).not.toBeInTheDocument();
    expect(screen.queryByText(/Login fails on Safari/)).not.toBeInTheDocument();
  });

  test('the GitHub login is not on the notes screen', async () => {
    await openAsOwner({ routes: { '/api/connectors': () => json({ github: { available: true, connected: true, login: 'octo-ana' } }) } });
    await send(result(LIST));
    await screen.findByRole('heading', { name: 'Open issues in acme/arlo-app' });
    expect(document.body.textContent).not.toContain('octo-ana');
  });
});

describe('the approval sheet for creating an issue', () => {
  test('shows the title and the description with their line breaks', async () => {
    await openAsOwner();
    const body = 'Login fails on Safari\n\nSteps:\n1. Open the page\n2. Click "Sign in"';
    await send(serverMessage.approval({
      id: A1, kind: 'agent_action', askedBy: 'Ana', askerVerified: true, channel: 'panel',
      question: 'Create this GitHub issue as you?', primaryLabel: 'Create issue', body,
    }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Create this GitHub issue as you?' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create issue' })).toBeInTheDocument();
    const box = within(dialog).getByRole('region', { name: 'What will be posted' });
    // The text as it came, in one text node: the line breaks are in it, and the CSS keeps them
    expect(box.textContent).toBe(body);
    expect(box.children).toHaveLength(0);
    expect(box).toHaveClass('arlo-sheet-body');
    const css = cssOf('src/components/arlo/ApprovalSheet.css');
    expect(css).toMatch(/\.arlo-sheet-body \{[^}]*white-space: pre-wrap;/);
  });
});
