import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage, MEETING,
  arloPath, arloAction,
} from '../test/harness';

// The meeting record: what was said and what happened, in order, for everyone
// in the meeting. Driven through the real app in a fake Zoom meeting.

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const base = `/api/meetings/by-zoom-id/${encodeURIComponent(MEETING)}`;
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const line = (seqNo, text, offsetMs, speakerLabel = 'Ana') => ({
  seqNo, text, speakerId: '1', speakerLabel, tStartMs: T0 + offsetMs, tEndMs: T0 + offsetMs,
});
const event = (id, eventType, participantName, offsetMs) => ({
  id, eventType, participantName, participantId: null, timestamp: T0 + offsetMs,
});

const STORED = {
  [`${base}/transcript`]: () => json({ segments: [line(1, 'Let us start with the launch date.', 2000), line(2, 'March 3 works for billing.', 6000, 'Ben')] }),
  [`${base}/participant-events`]: () => json({
    events: [
      event('e1', 'transcription_started', 'Arlo', 1000),
      event('e2', 'joined', 'Bo', 4000),
    ],
  }),
};

async function openRecord({ routes = {}, guest = false, sdk } = {}) {
  const fetchMock = mockFetch(routes, { signedIn: !guest });
  const result = renderInMeeting({ sdk, guest, page: 'record' });
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  return { ...result, fetchMock };
}
const entries = () => [...screen.getByRole('log').children].map((node) => node.textContent);

afterEach(resetHarness);

test('lines and events appear in time order, stored and live alike', async () => {
  await openRecord({ routes: STORED });
  expect(await screen.findByRole('heading', { name: 'Meeting record' })).toBeInTheDocument();
  await screen.findByText('March 3 works for billing.');
  await send(serverMessage.timelineEvent(event('e3', 'transcription_paused', 'Arlo', 8000)));
  await send(serverMessage.segment(3, 'One more thing.', { tStartMs: T0 + 9000 }));

  const shown = entries();
  expect(shown).toHaveLength(6);
  expect(shown[0]).toContain('Transcription started');
  expect(shown[1]).toContain('Let us start with the launch date.');
  expect(shown[2]).toContain('Bo joined the meeting');
  expect(shown[3]).toContain('March 3 works for billing.');
  expect(shown[3]).toContain('Ben');
  expect(shown[4]).toContain('Transcription paused');
  expect(shown[5]).toContain('One more thing.');
});

test('"Only Arlo\'s actions" hides what was said and other people\'s events', async () => {
  await openRecord({ routes: STORED });
  await screen.findByText('March 3 works for billing.');
  const toggle = screen.getByRole('checkbox', { name: 'Only Arlo\'s actions' });
  expect(toggle).not.toBeChecked();

  await userEvent.click(toggle);
  expect(toggle).toBeChecked();
  expect(entries()).toHaveLength(1);
  expect(within(screen.getByRole('log')).getByText('Transcription started')).toBeInTheDocument();
  expect(screen.queryByText('March 3 works for billing.')).not.toBeInTheDocument();
  expect(screen.queryByText('Bo joined the meeting')).not.toBeInTheDocument();

  await userEvent.click(toggle);
  expect(entries()).toHaveLength(4);
});

test('with nothing said yet, it says so', async () => {
  await openRecord();
  expect(await screen.findByText('Nothing has been said since Arlo joined.')).toBeInTheDocument();
  expect(screen.queryByRole('log')).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole('checkbox', { name: 'Only Arlo\'s actions' }));
  expect(screen.getByText('Arlo has not done anything yet.')).toBeInTheDocument();
});

test('Back returns to the meeting screen', async () => {
  await openRecord({ routes: STORED });
  await userEvent.click(await screen.findByRole('link', { name: 'Back' }));
  await waitFor(() => expect(window.location.hash).toBe(`#/meeting/${encodeURIComponent(MEETING)}`));
  expect(screen.queryByRole('heading', { name: 'Meeting record' })).not.toBeInTheDocument();
});

test('a guest in the meeting can read the record, and Back stays on the guest route', async () => {
  await openRecord({
    routes: STORED,
    guest: true,
    sdk: createZoomSdk({ status: 'authenticated', role: 'attendee', screenName: 'Guest' }),
  });
  expect(await screen.findByText('March 3 works for billing.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('link', { name: 'Back' }));
  await waitFor(() => expect(window.location.hash).toBe(`#/guest-meeting/${encodeURIComponent(MEETING)}`));
});

test('a panel the server could not place in the meeting shows the reason, not a record', async () => {
  mockFetch({ ...STORED, '/api/auth/meeting-access': () => json({ error: 'This app context has expired.' }, 403) });
  renderInMeeting({ page: 'record' });
  expect(await screen.findByRole('alert')).toHaveTextContent('This app context has expired.');
  expect(screen.queryByRole('log')).not.toBeInTheDocument();
});

describe('what Arlo was asked and did', () => {
  const action = (id, label, offsetMs, extra = {}) => arloAction({ id, label, at: T0 + offsetMs, ...extra });
  const ACTIONS = {
    ...STORED,
    [arloPath('actions')]: () => json({
      actions: [
        action('a1', 'Posted the launch date to the chat', 5000, { askedBy: 'Ben' }),
        action('a2', 'Admit James from the waiting room', 7000, { askedBy: 'Bo', status: 'declined' }),
      ],
    }),
  };

  test('actions appear among the lines and events, by time, with how they ended when not done', async () => {
    await openRecord({ routes: ACTIONS });
    await screen.findByText('March 3 works for billing.');
    await screen.findByText(/Posted the launch date to the chat/);
    await send(serverMessage.did(action('a3', 'Post the summary to the chat', 8000, { status: 'expired' })));
    await send(serverMessage.did(action('a4', 'Admit Noor from the waiting room', 9000, { status: 'failed' })));
    await send(serverMessage.did(action('a5', 'Still waiting', 9500, { status: 'waiting_approval' })));

    const shown = entries();
    expect(shown).toHaveLength(8);
    expect(shown[0]).toContain('Transcription started');
    expect(shown[1]).toContain('Let us start with the launch date.');
    expect(shown[2]).toContain('Bo joined the meeting');
    expect(shown[3]).toContain('Posted the launch date to the chat · Ben asked');
    expect(shown[3]).not.toMatch(/declined|no answer|couldn't/);
    expect(shown[4]).toContain('March 3 works for billing.');
    expect(shown[5]).toContain('Admit James from the waiting room · Bo asked · declined');
    expect(shown[6]).toContain('Post the summary to the chat · no answer');
    expect(shown[7]).toContain('Admit Noor from the waiting room · couldn\'t do it');
    expect(screen.queryByText(/Still waiting/)).not.toBeInTheDocument();
  });

  test('"Only Arlo\'s actions" keeps them', async () => {
    await openRecord({ routes: ACTIONS });
    await screen.findByText(/Posted the launch date to the chat/);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only Arlo\'s actions' }));
    const shown = entries();
    expect(shown).toHaveLength(3);
    expect(shown[0]).toContain('Transcription started');
    expect(shown[1]).toContain('Posted the launch date to the chat');
    expect(shown[2]).toContain('Admit James from the waiting room');
  });

  test('a record with nothing said but something done shows it', async () => {
    await openRecord({ routes: { [arloPath('actions')]: ACTIONS[arloPath('actions')] } });
    expect(await screen.findByText(/Posted the launch date to the chat/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing has been said since Arlo joined.')).not.toBeInTheDocument();
  });

  test('a guest sees the public actions the server gives, and never keeps a private one', async () => {
    await openRecord({
      routes: ACTIONS,
      guest: true,
      sdk: createZoomSdk({ status: 'authenticated', role: 'attendee', screenName: 'Guest' }),
    });
    await screen.findByText(/Posted the launch date to the chat/);
    await send(serverMessage.did(action('a9', 'A private answer', 9000, { isPublic: false })));
    await send(serverMessage.segment(3, 'One more thing.', { tStartMs: T0 + 9500 }));
    await screen.findByText('One more thing.');
    expect(screen.queryByText(/A private answer/)).not.toBeInTheDocument();
  });
});
