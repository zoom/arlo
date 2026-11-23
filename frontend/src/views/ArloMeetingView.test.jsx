import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
  arloPath, ARLO_ABSENT,
} from '../test/harness';

// The single-action Arlo screens, driven through the real app in a fake Zoom
// meeting: one test (or a few) per screen.

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
const OWNER = { present: true, role: 'owner', ownerName: 'Ana' };
const ANA_BROUGHT_ARLO = { present: true, role: 'participant', ownerName: 'Ana' };

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const startCalls = (sdk) => sdk.callZoomApi.mock.calls.filter(([name]) => name === 'startRTMS');
const callsTo = (fetchMock, path) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(path));
const attendee = () => createZoomSdk({ role: 'attendee', screenName: 'Ben' });

async function openArlo({ sdk, guest = false, routes = {}, state } = {}) {
  const fetchMock = mockFetch({
    ...(state && { [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }) }),
    ...routes,
  }, { signedIn: !guest });
  const result = renderInMeeting({ sdk, guest, arlo: true });
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  return { ...result, fetchMock };
}

/** The owner's panel with Arlo in the meeting and the stream confirmed. */
async function openAsOwner(options = {}) {
  const result = await openArlo({ state: OWNER, ...options });
  await send(serverMessage.status('rtms_started'));
  await screen.findByText('Arlo is in the meeting');
  return result;
}

afterEach(resetHarness);

describe('bring Arlo in (host)', () => {
  test('one action, and nothing is requested before the click', async () => {
    const { sdk } = await openArlo();
    expect(await screen.findByRole('heading', { name: 'Bring Arlo into this meeting' })).toBeInTheDocument();
    expect(screen.getByText('Arlo listens through Zoom\'s transcript and takes notes for you. Everyone in the meeting can see that Arlo is here.')).toBeInTheDocument();
    const choice = screen.getByRole('radiogroup', { name: 'Who can ask Arlo' });
    expect(within(choice).getByRole('radio', { name: 'Only I can ask' })).toBeChecked();
    expect(within(choice).getByRole('radio', { name: 'Anyone can ask' })).not.toBeChecked();
    expect(screen.getAllByRole('button', { name: 'Bring Arlo into this meeting' })).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 900)); // past the auto-start delay
    expect(startCalls(sdk)).toHaveLength(0);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  test('the click asks Zoom once, and the choice is sent once this person is the owner', async () => {
    const { sdk, fetchMock } = await openArlo();
    await userEvent.click(await screen.findByRole('radio', { name: 'Anyone can ask' }));
    await userEvent.click(screen.getByRole('button', { name: 'Bring Arlo into this meeting' }));

    expect(startCalls(sdk)).toHaveLength(1);
    // A request is not a state: no notes yet, no setting sent yet
    expect(await screen.findByText('Bringing Arlo in…')).toBeInTheDocument();
    expect(screen.queryByText('Arlo is in the meeting')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, arloPath('settings'))).toHaveLength(0);

    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState(OWNER));

    expect(await screen.findByText('Arlo is in the meeting')).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, arloPath('settings'))).toHaveLength(1));
    const [, init] = callsTo(fetchMock, arloPath('settings'))[0];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ whoCanAsk: 'anyone' });
    expect(startCalls(sdk)).toHaveLength(1);
  });

  test('the default choice needs no request: the server already has it', async () => {
    const { fetchMock } = await openArlo();
    await userEvent.click(await screen.findByRole('button', { name: 'Bring Arlo into this meeting' }));
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState(OWNER));
    await screen.findByText('Arlo is in the meeting');
    expect(callsTo(fetchMock, arloPath('settings'))).toHaveLength(0);
  });

  test('a start error from Zoom is shown, with the same one action', async () => {
    const sdk = createZoomSdk({
      startRTMS: async () => { throw Object.assign(new Error('RTMS is not enabled for this app'), { code: '10301' }); },
    });
    await openArlo({ sdk });
    await userEvent.click(await screen.findByRole('button', { name: 'Bring Arlo into this meeting' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('RTMS is not enabled for this app');
    expect(screen.getByRole('button', { name: 'Bring Arlo into this meeting' })).toBeEnabled();
  });
});

describe('ask the host (signed-in attendee)', () => {
  test('nothing is requested before the click; the click asks once and then waits', async () => {
    const { sdk } = await openArlo({ sdk: attendee() });
    expect(await screen.findByRole('heading', { name: 'Arlo isn\'t in this meeting yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bring Arlo into this meeting' })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(startCalls(sdk)).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Ask the host to bring Arlo in' }));
    expect(startCalls(sdk)).toHaveLength(1);

    const waiting = await screen.findByRole('status');
    expect(waiting).toHaveTextContent('Waiting for the host to allow Arlo…');
    expect(waiting).toHaveTextContent(/\d+s/);
    // The request is not Arlo being here
    expect(screen.queryByText('Arlo is in the meeting')).not.toBeInTheDocument();
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
  });

  test('a request shows the wait even for an owner who has notes', async () => {
    await openAsOwner({ sdk: attendee(), routes: { [arloPath('notes')]: () => json({ notes: NOTES }) } });
    await screen.findByText(NOTES.summary);
    await send(serverMessage.status('rtms_stopped'));
    await send(serverMessage.arloState({ ...OWNER, present: false }));
    await userEvent.click(await screen.findByRole('button', { name: 'Bring Arlo back' }));

    expect(await screen.findByText(/Waiting for the host to allow Arlo…/)).toBeInTheDocument();
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
  });

  test('a long wait offers "Try again", because Zoom does not say when the host allows Arlo', async () => {
    const { sdk } = await openArlo({ sdk: attendee() });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask the host to bring Arlo in' }));
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    const again = await screen.findByRole('button', { name: 'Try again' }, { timeout: 7000 });
    expect(screen.getByText('Has the host allowed Arlo?')).toBeInTheDocument();
    await userEvent.click(again);
    await waitFor(() => expect(startCalls(sdk)).toHaveLength(2));
  }, 15000);

  test('the host declining gives the reason and the action back', async () => {
    await openArlo({ sdk: attendee() });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask the host to bring Arlo in' }));
    await screen.findByText(/Waiting for the host to allow Arlo…/);
    await send(serverMessage.requestStatus(3));

    expect(await screen.findByRole('alert')).toHaveTextContent('The host declined the transcription request.');
    expect(screen.getByRole('button', { name: 'Ask the host to bring Arlo in' })).toBeEnabled();
  });

  test('Zoom allowing the app without a stream yet shows "Bringing Arlo in…"', async () => {
    const { sdk } = await openArlo({ sdk: attendee() });
    await screen.findByRole('heading', { name: 'Arlo isn\'t in this meeting yet' });
    await act(async () => { sdk.emit('onRTMSStatusChange', { status: 'started' }); });
    expect(await screen.findByText('Bringing Arlo in…')).toBeInTheDocument();
  });
});

describe('live notes (owner)', () => {
  test('before the first notes, Arlo says it is listening', async () => {
    await openAsOwner();
    expect(screen.getByText('Arlo is listening. Notes appear after the first minute or so.')).toBeInTheDocument();
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
  });

  test('notes.updated shows the three sections, the record link and the ask input', async () => {
    await openAsOwner();
    await send(serverMessage.notes(NOTES));

    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeInTheDocument();
    expect(screen.getByText('Keep the three-tier pricing')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Action items' })).toBeInTheDocument();
    expect(screen.getByText('Send the revised timeline · Ana')).toBeInTheDocument();
    expect(screen.getByText('Draft the beta invite email')).toBeInTheDocument();
    expect(screen.queryByText(/Arlo is listening/)).not.toBeInTheDocument();
    // Only the summary is announced as it changes
    expect(screen.getByText(NOTES.summary).closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Keep the three-tier pricing').closest('[aria-live]')).toBeNull();

    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask Arlo' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  test('empty sections are not rendered', async () => {
    await openAsOwner();
    await send(serverMessage.notes({ ...NOTES, decisions: [], actionItems: [] }));
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Decisions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Action items' })).not.toBeInTheDocument();
  });

  test('notes of another meeting never show', async () => {
    await openAsOwner();
    await send(serverMessage.notes({ ...NOTES, summary: 'From another meeting.' }, 'OTHER-MEETING'));
    expect(screen.queryByText('From another meeting.')).not.toBeInTheDocument();
    expect(screen.getByText(/Arlo is listening/)).toBeInTheDocument();
  });

  test('Pause is a request; "Arlo is paused" shows when it is confirmed', async () => {
    const { sdk } = await openAsOwner();
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(sdk.pauseRTMS).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Arlo is paused')).not.toBeInTheDocument();

    await send(serverMessage.status('rtms_paused'));
    await send(serverMessage.arloState({ ...OWNER, paused: true }));
    expect(await screen.findByText('Arlo is paused')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(sdk.resumeRTMS).toHaveBeenCalledTimes(1);
  });

  test('Remove Arlo needs a second click; afterwards the notes stay with "Bring Arlo back"', async () => {
    const { sdk } = await openAsOwner();
    await send(serverMessage.notes(NOTES));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Arlo' }));
    expect(sdk.stopRTMS).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Arlo?' }));
    expect(sdk.stopRTMS).toHaveBeenCalledTimes(1);

    await send(serverMessage.status('rtms_stopped'));
    await send(serverMessage.arloState({ ...OWNER, present: false }));
    expect(await screen.findByText('Arlo has left')).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bring Arlo back' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  });

  test('a dropped connection says "Reconnecting…", and a fault says why Arlo left', async () => {
    await openAsOwner();
    await send(serverMessage.notes(NOTES));
    await send(serverMessage.status('rtms_interrupted'));
    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument();

    await send(serverMessage.status('rtms_stopped', { fault: true }));
    await send(serverMessage.arloState({ ...OWNER, present: false }));
    expect(await screen.findByText('Arlo has left')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Transcription stopped because of a connection problem.');
    expect(screen.getByRole('button', { name: 'Bring Arlo back' })).toBeInTheDocument();
  });
});

describe('ask Arlo', () => {
  test('asking shows the answer above the input, and Clear removes it', async () => {
    const bodies = [];
    await openAsOwner({
      routes: {
        [`POST ${arloPath('ask')}`]: ({ body }) => { bodies.push(body); return json({ answer: 'Ben will confirm the date.' }); },
      },
    });
    const input = screen.getByRole('textbox', { name: 'Ask Arlo' });
    expect(input).toHaveAttribute('placeholder', 'Ask Arlo');
    await userEvent.type(input, 'What did Ben commit to?{Enter}');

    expect(await screen.findByText('Ben will confirm the date.')).toBeInTheDocument();
    expect(bodies).toEqual([{ question: 'What did Ben commit to?' }]);
    expect(input).toHaveValue('');
    expect(input).toBeEnabled();

    await userEvent.type(input, 'And when?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(bodies).toHaveLength(2));

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('Ben will confirm the date.')).not.toBeInTheDocument();
  });

  test('the input is disabled while Arlo answers, and an error is an alert', async () => {
    let answer;
    await openAsOwner({
      routes: { [`POST ${arloPath('ask')}`]: () => new Promise((resolve) => { answer = resolve; }) },
    });
    const input = screen.getByRole('textbox', { name: 'Ask Arlo' });
    await userEvent.type(input, 'What was decided?{Enter}');
    await waitFor(() => expect(input).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();

    await act(async () => { answer(json({ error: 'no_transcript' }, 409)); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing has been said since Arlo joined.');
    expect(input).toBeEnabled();
    expect(input).toHaveValue('What was decided?');
  });
});

describe('participant', () => {
  test('sees who brought Arlo in, and never the notes', async () => {
    await openArlo({ sdk: attendee(), state: ANA_BROUGHT_ARLO });
    await send(serverMessage.status('rtms_started'));
    expect(await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' })).toBeInTheDocument();
    expect(screen.getByText('Arlo reads Zoom\'s live transcript to take notes for Ana. Nothing is stored after the meeting ends.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();

    await send(serverMessage.notes(NOTES));
    expect(screen.queryByText(NOTES.summary)).not.toBeInTheDocument();
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
  });

  test('an attendee has no Pause or Remove', async () => {
    await openArlo({ sdk: attendee(), state: ANA_BROUGHT_ARLO });
    await send(serverMessage.status('rtms_started'));
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Arlo' })).not.toBeInTheDocument();
  });

  test('a host who is not the owner sees the plain participant view: the stream is not theirs to control', async () => {
    const { sdk } = await openArlo({ state: ANA_BROUGHT_ARLO });
    await send(serverMessage.status('rtms_started'));
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    expect(screen.queryByText(/Arlo is listening/)).not.toBeInTheDocument();
    expect(screen.queryByText('Arlo is in the meeting')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Arlo' })).not.toBeInTheDocument();
    expect(sdk.pauseRTMS).not.toHaveBeenCalled();
    expect(sdk.stopRTMS).not.toHaveBeenCalled();
  });

  test('"Only I can ask" hides the input and says who can ask', async () => {
    await openArlo({ sdk: attendee(), state: ANA_BROUGHT_ARLO });
    expect(await screen.findByText('Only Ana can ask Arlo in this meeting.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Ask Arlo' })).not.toBeInTheDocument();
  });

  test('"Anyone can ask" gives the participant the private input, also when it changes live', async () => {
    await openArlo({ sdk: attendee(), state: ANA_BROUGHT_ARLO });
    await screen.findByText('Only Ana can ask Arlo in this meeting.');
    await send(serverMessage.arloState({ ...ANA_BROUGHT_ARLO, whoCanAsk: 'anyone' }));
    expect(await screen.findByRole('textbox', { name: 'Ask Arlo' })).toBeInTheDocument();
    expect(screen.queryByText('Only Ana can ask Arlo in this meeting.')).not.toBeInTheDocument();
  });

  test('without a name the heading says Arlo is in this meeting', async () => {
    await openArlo({ sdk: attendee(), state: { present: true, role: 'participant', ownerName: null } });
    expect(await screen.findByRole('heading', { name: 'Arlo is in this meeting' })).toBeInTheDocument();
  });
});

describe('guest', () => {
  const guestSdk = () => createZoomSdk({ status: 'authenticated', role: 'attendee', screenName: 'Guest' });

  test('sees "Sign in to ask Arlo" in place of the input, and no controls', async () => {
    const { sdk } = await openArlo({ sdk: guestSdk(), guest: true, state: { ...ANA_BROUGHT_ARLO, whoCanAsk: 'anyone' } });
    expect(await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Ask Arlo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in to ask Arlo' }));
    await waitFor(() => expect(sdk.authorize).toHaveBeenCalledTimes(1));
    expect(startCalls(sdk)).toHaveLength(0);
  });

  test('after signing in, the panel reconnects as that person and offers the input', async () => {
    const { sdk } = await openArlo({
      sdk: guestSdk(),
      guest: true,
      state: { ...ANA_BROUGHT_ARLO, whoCanAsk: 'anyone' },
      routes: { '/api/auth/callback': () => json({ user: { id: 'user-2', displayName: 'Guest' } }) },
    });
    const first = server();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to ask Arlo' }));
    await waitFor(() => expect(sdk.authorize).toHaveBeenCalledTimes(1));
    await act(async () => { sdk.emit('onAuthorized', { code: 'one-time-code' }); });

    expect(await screen.findByRole('textbox', { name: 'Ask Arlo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in to ask Arlo' })).not.toBeInTheDocument();
    await waitFor(() => expect(server()).not.toBe(first));
  });

  test('when Arlo is not in the meeting a guest gets no bring-in action', async () => {
    await openArlo({ sdk: createZoomSdk({ status: 'authenticated', role: 'host' }), guest: true });
    expect(await screen.findByRole('heading', { name: 'Arlo isn\'t in this meeting' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bring Arlo into this meeting' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask the host to bring Arlo in' })).not.toBeInTheDocument();
  });
});

describe('after the meeting', () => {
  async function endMeeting() {
    // As the server sends them: the end, then the flushed state
    await act(async () => {
      server().serverSend(serverMessage.status('rtms_stopped', { meetingEnded: true }));
      server().serverSend(serverMessage.arloState({ present: false, role: 'participant', ownerName: null }));
    });
  }

  test('the owner keeps the notes, with "Copy notes" and the demo line', async () => {
    const writeText = vi.fn(async () => {});
    await openAsOwner();
    await send(serverMessage.notes(NOTES));
    await endMeeting();

    expect(await screen.findByRole('heading', { name: 'Planning' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByText('Send the revised timeline · Ana')).toBeInTheDocument();
    expect(screen.getByText('Demo mode: meetings and notes are not stored.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meeting record' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bring Arlo back' })).not.toBeInTheDocument();

    // After setup(), which installs its own clipboard stub
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Copy notes' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('Planning\n\nSummary\n');
    expect(writeText.mock.calls[0][0]).toContain('- Send the revised timeline · Ana');
    expect(await screen.findByText('Notes copied')).toBeInTheDocument();
  });

  test('the notes stay when Zoom then reports that the user left the meeting', async () => {
    const { sdk } = await openAsOwner();
    await send(serverMessage.notes(NOTES));
    await endMeeting();
    await screen.findByRole('button', { name: 'Copy notes' });

    await act(async () => { sdk.emit('onRunningContextChange', { runningContext: 'inMainClient' }); });
    expect(screen.getByRole('heading', { name: 'Planning' })).toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
  });

  test('"Copy notes" works without the clipboard API, through the page itself', async () => {
    await openAsOwner();
    await send(serverMessage.notes(NOTES));
    await endMeeting();

    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const copied = [];
    const execCommand = document.execCommand;
    document.execCommand = vi.fn(() => { copied.push(document.activeElement?.value); return true; });
    try {
      await user.click(screen.getByRole('button', { name: 'Copy notes' }));
      expect(await screen.findByText('Notes copied')).toBeInTheDocument();
      expect(copied).toHaveLength(1);
      expect(copied[0]).toContain('Planning\n\nSummary\n');
    } finally {
      document.execCommand = execCommand;
    }
  });

  test('"Copy notes" says so when nothing could be copied', async () => {
    await openAsOwner();
    await send(serverMessage.notes(NOTES));
    await endMeeting();

    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => { throw new Error('NotAllowedError'); } }, configurable: true,
    });
    const execCommand = document.execCommand;
    document.execCommand = vi.fn(() => false);
    try {
      await user.click(screen.getByRole('button', { name: 'Copy notes' }));
      expect(await screen.findByText('Could not copy the notes')).toBeInTheDocument();
      expect(screen.queryByText('Notes copied')).not.toBeInTheDocument();
    } finally {
      document.execCommand = execCommand;
    }
  });

  test('without the demo flag there is no demo line', async () => {
    await openAsOwner({ routes: { '/api/auth/settings': () => json({ demoMode: false }) } });
    await send(serverMessage.notes(NOTES));
    await endMeeting();
    await screen.findByRole('button', { name: 'Copy notes' });
    expect(screen.queryByText(/Demo mode/)).not.toBeInTheDocument();
  });

  test('a participant sees that Arlo is not in the meeting, and no notes', async () => {
    await openArlo({ sdk: attendee(), state: ANA_BROUGHT_ARLO });
    await send(serverMessage.status('rtms_started'));
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    await endMeeting();
    expect(await screen.findByRole('heading', { name: 'Arlo isn\'t in this meeting' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy notes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask the host to bring Arlo in' })).not.toBeInTheDocument();
  });
});

describe('meeting access', () => {
  test('a panel the server could not place in the meeting shows the reason, not a screen', async () => {
    await mockFetch({ '/api/auth/meeting-access': () => json({ error: 'This app context has expired.' }, 403) });
    renderInMeeting({ arlo: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('This app context has expired.');
    expect(screen.queryByRole('button', { name: 'Bring Arlo into this meeting' })).not.toBeInTheDocument();
  });
});
