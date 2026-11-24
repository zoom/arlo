import React, { useEffect } from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, resetHarness, serverMessage, arloPath, ARLO_ABSENT, MEETING,
} from '../test/harness';
import { ZoomSdkProvider } from './ZoomSdkContext';
import { AuthProvider, useAuth } from './AuthContext';
import { ServerSettingsProvider } from './ServerSettingsContext';
import { MeetingProvider, useMeeting } from './MeetingContext';
import { ArloProvider, useArlo } from './ArloContext';

// The real providers in a fake Zoom meeting. The probe stands where a screen
// would: it opens the meeting socket and reads what useArlo() gives.

const NOTES = {
  summary: 'The beta moves to March 3.',
  decisions: ['Beta launch moves to March 3'],
  actionItems: [{ text: 'Send the revised timeline', owner: 'Ana' }],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 7,
};
const OWNER = { present: true, role: 'owner', ownerName: 'Ana' };

let arlo;
let meeting;
let auth;
function Probe() {
  meeting = useMeeting();
  arlo = useArlo();
  auth = useAuth();
  const { ws, meetingId, connectWebSocket } = meeting;
  useEffect(() => {
    if (!ws && meetingId) connectWebSocket(meetingId);
  }, [ws, meetingId, connectWebSocket]);
  return null;
}

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const callsTo = (fetchMock, path) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(path));

async function open(routes = {}) {
  const fetchMock = mockFetch(routes);
  window.zoomSdk = createZoomSdk();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.setItem('arlo-auto-start', 'false');
  render(
    <ZoomSdkProvider>
      <AuthProvider>
        <ServerSettingsProvider>
          <MeetingProvider>
            <ArloProvider>
              <Probe />
            </ArloProvider>
          </MeetingProvider>
        </ServerSettingsProvider>
      </AuthProvider>
    </ZoomSdkProvider>,
  );
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await waitFor(() => expect(arlo.loaded).toBe(true));
  return fetchMock;
}

const asOwner = () => open({
  [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...OWNER }),
  [arloPath('notes')]: () => json({ notes: NOTES }),
});

afterEach(resetHarness);

describe('Arlo\'s state', () => {
  test('is not loaded before the server answered, then comes from the state route', async () => {
    const fetchMock = await open({
      [arloPath('state')]: () => json({ ...ARLO_ABSENT, present: true, ownerName: 'Ana', whoCanAsk: 'anyone' }),
    });
    expect(arlo).toMatchObject({
      loaded: true, present: true, paused: false, role: 'participant', ownerName: 'Ana', whoCanAsk: 'anyone', everPresent: true, notes: null,
    });
    // After meeting access was verified, with the cookies
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.findIndex((url) => url.startsWith(arloPath('state'))))
      .toBeGreaterThan(urls.findIndex((url) => url.includes('/api/auth/meeting-access')));
    callsTo(fetchMock, arloPath('state')).forEach(([, init]) => expect(init.credentials).toBe('include'));
  });

  test('a participant never asks for the notes', async () => {
    const fetchMock = await open();
    expect(arlo.role).toBe('participant');
    expect(callsTo(fetchMock, arloPath('notes'))).toHaveLength(0);
  });

  test('an owner gets the notes', async () => {
    const fetchMock = await asOwner();
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    callsTo(fetchMock, arloPath('notes')).forEach(([, init]) => expect(init.credentials).toBe('include'));
  });

  test('arlo.state from the socket updates the role, and becoming an owner fetches the notes', async () => {
    const fetchMock = await open({ [arloPath('notes')]: () => json({ notes: NOTES }) });
    expect(arlo.everPresent).toBe(false);
    await send(serverMessage.arloState(OWNER));
    expect(arlo).toMatchObject({ role: 'owner', present: true, ownerName: 'Ana', everPresent: true });
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    expect(callsTo(fetchMock, arloPath('notes')).length).toBeGreaterThan(0);

    // Arlo leaves: it was here, and the owner is still the owner
    await send(serverMessage.arloState({ ...OWNER, present: false }));
    expect(arlo).toMatchObject({ present: false, everPresent: true, role: 'owner' });
  });

  test('messages for another meeting are ignored', async () => {
    await asOwner();
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    await send(serverMessage.arloState({ present: false, role: 'participant', ownerName: 'Someone else' }, 'OTHER-MEETING'));
    await send(serverMessage.notes({ ...NOTES, summary: 'Notes of another meeting.' }, 'OTHER-MEETING'));
    await send({ type: 'meeting.status', data: { meetingId: 'OTHER-MEETING', status: 'rtms_stopped', meetingEnded: true } });
    expect(arlo).toMatchObject({ role: 'owner', ownerName: 'Ana', present: true });
    expect(arlo.notes.summary).toBe(NOTES.summary);
    expect(meeting.meetingEnded).toBe(false);
  });

  test('notes.updated replaces the notes, with unknown fields dropped', async () => {
    await asOwner();
    await send(serverMessage.notes({ ...NOTES, summary: 'Pricing stays as proposed.', html: '<b>no</b>' }));
    expect(arlo.notes.summary).toBe('Pricing stays as proposed.');
    expect(arlo.notes).not.toHaveProperty('html');
    // Something that is not notes changes nothing
    await send(serverMessage.notes('not notes'));
    expect(arlo.notes.summary).toBe('Pricing stays as proposed.');
  });

  test('notes sent to someone who is not an owner are not kept', async () => {
    await open();
    await send(serverMessage.notes(NOTES));
    expect(arlo.notes).toBeNull();
  });

  test('the notes are cleared when the role stops being owner', async () => {
    await asOwner();
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    await send(serverMessage.arloState({ present: true, role: 'participant', ownerName: 'Ben' }));
    expect(arlo.role).toBe('participant');
    expect(arlo.notes).toBeNull();
  });

  test('a malformed arlo.state is ignored', async () => {
    await asOwner();
    await send({ type: 'arlo.state', data: { meetingId: 'MEETING-1==', present: 'yes', role: 'admin' } });
    expect(arlo).toMatchObject({ role: 'owner', present: true });
  });
});

describe('after the meeting ended', () => {
  test('the owner keeps the role and the notes, although the server has flushed both', async () => {
    let flushed = false;
    await open({
      [arloPath('state')]: () => json(flushed ? { ...ARLO_ABSENT } : { ...ARLO_ABSENT, ...OWNER }),
      [arloPath('notes')]: () => (flushed ? json({ error: 'Forbidden' }, 403) : json({ notes: NOTES })),
    });
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    expect(meeting.meetingEnded).toBe(false);

    flushed = true;
    // Both in one turn, as the server sends them
    await act(async () => {
      server().serverSend(serverMessage.status('rtms_stopped', { meetingEnded: true }));
      server().serverSend(serverMessage.arloState({ present: false, role: 'participant', ownerName: null }));
    });
    expect(meeting.meetingEnded).toBe(true);
    expect(arlo).toMatchObject({ role: 'owner', ownerName: 'Ana', present: false, everPresent: true });
    expect(arlo.notes).toEqual(NOTES);

    // Later messages change nothing either
    await send(serverMessage.arloState({ present: false, role: 'participant' }));
    expect(arlo.role).toBe('owner');
    expect(arlo.notes).toEqual(NOTES);
  });

  test('a stop that is not the end of the meeting does not set meetingEnded', async () => {
    await asOwner();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.status('rtms_stopped'));
    expect(meeting.meetingEnded).toBe(false);
  });
});

describe('ask', () => {
  test('sends the trimmed question and nothing else, and gives the answer', async () => {
    const bodies = [];
    const fetchMock = await open({
      [`POST ${arloPath('ask')}`]: ({ body }) => { bodies.push(body); return json({ answer: 'March 3.' }); },
    });
    let result;
    await act(async () => { result = await arlo.ask('  When is the beta?  '); });
    expect(result).toEqual({ answer: 'March 3.' });
    expect(bodies).toEqual([{ question: 'When is the beta?' }]);
    expect(arlo.asking).toBe(false);
    const [, init] = callsTo(fetchMock, arloPath('ask'))[0];
    expect(init.credentials).toBe('include');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  test('an empty or too long question is refused without a request', async () => {
    const fetchMock = await open();
    let empty; let long; let notText;
    await act(async () => {
      empty = await arlo.ask('   ');
      long = await arlo.ask('x'.repeat(501));
      notText = await arlo.ask(undefined);
    });
    expect(empty.error).toMatch(/question/i);
    expect(long.error).toMatch(/500/);
    expect(notText.error).toMatch(/question/i);
    expect(callsTo(fetchMock, arloPath('ask'))).toHaveLength(0);
  });

  test.each([
    [401, { error: 'Authentication required' }, /sign in/i],
    [403, { error: 'Forbidden', message: 'server text' }, /can't ask Arlo/i],
    [409, { error: 'no_transcript' }, /nothing has been said/i],
    [429, { error: 'rate limited' }, /try again in a minute/i],
    [502, { error: 'bad gateway' }, /could not answer/i],
    [503, { error: 'AI features are disabled' }, /could not answer/i],
    [200, { answer: 42 }, /could not answer/i],
  ])('a %i answer becomes a short message', async (status, body, expected) => {
    await open({ [`POST ${arloPath('ask')}`]: () => json(body, status) });
    let result;
    await act(async () => { result = await arlo.ask('What was decided?'); });
    expect(result.error).toMatch(expected);
    expect(result.error).not.toContain('server text');
    expect(result).not.toHaveProperty('answer');
    expect(arlo.asking).toBe(false);
  });

  test('a request that fails to reach the server is a message, not a throw', async () => {
    await open({ [`POST ${arloPath('ask')}`]: () => { throw new TypeError('Failed to fetch'); } });
    let result;
    await act(async () => { result = await arlo.ask('What was decided?'); });
    expect(result.error).toMatch(/could not answer/i);
  });
});

describe('setWhoCanAsk', () => {
  test('sends exactly { whoCanAsk } and takes the state the server answers', async () => {
    const bodies = [];
    const fetchMock = await open({
      [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...OWNER }),
      [`PUT ${arloPath('settings')}`]: ({ body }) => {
        bodies.push(body);
        return json({ ...ARLO_ABSENT, ...OWNER, whoCanAsk: body.whoCanAsk });
      },
    });
    let ok;
    await act(async () => { ok = await arlo.setWhoCanAsk('anyone'); });
    expect(ok).toBe(true);
    expect(bodies).toEqual([{ whoCanAsk: 'anyone' }]);
    expect(arlo.whoCanAsk).toBe('anyone');
    expect(callsTo(fetchMock, arloPath('settings'))[0][1].credentials).toBe('include');
  });

  test('a value that is not on the list is refused without a request', async () => {
    const fetchMock = await open();
    let ok;
    await act(async () => { ok = await arlo.setWhoCanAsk('everyone'); });
    expect(ok).toBe(false);
    expect(callsTo(fetchMock, arloPath('settings'))).toHaveLength(0);
  });

  test('a refusal leaves the setting as it was', async () => {
    await open({ [`PUT ${arloPath('settings')}`]: () => json({ error: 'Forbidden' }, 403) });
    let ok;
    await act(async () => { ok = await arlo.setWhoCanAsk('anyone'); });
    expect(ok).toBe(false);
    expect(arlo.whoCanAsk).toBe('owner');
  });
});

describe('myStreamPaused', () => {
  test('is the server\'s word about this person\'s own stream, apart from the meeting\'s `paused`', async () => {
    await asOwner();
    expect(arlo).toMatchObject({ paused: false, myStreamPaused: false });
    await send(serverMessage.arloState({ ...OWNER, paused: false, myStreamPaused: true }));
    expect(arlo).toMatchObject({ paused: false, myStreamPaused: true });
    await send(serverMessage.arloState({ ...OWNER, paused: true, myStreamPaused: true }));
    expect(arlo).toMatchObject({ paused: true, myStreamPaused: true });
    await send(serverMessage.arloState({ ...OWNER, paused: false, myStreamPaused: false }));
    expect(arlo).toMatchObject({ paused: false, myStreamPaused: false });
  });

  test('is false when the server does not send it, or sends something that is not a boolean', async () => {
    await asOwner();
    const withoutIt = { present: true, paused: true, role: 'owner', ownerName: 'Ana', whoCanAsk: 'owner' };
    await send({ type: 'arlo.state', data: { meetingId: MEETING, ...withoutIt } });
    expect(arlo).toMatchObject({ paused: true, myStreamPaused: false });
    await send({ type: 'arlo.state', data: { meetingId: MEETING, ...withoutIt, myStreamPaused: 'yes' } });
    expect(arlo.myStreamPaused).toBe(false);
  });
});

describe('the person stops being signed in', () => {
  const leaveMeeting = () => act(async () => {
    window.zoomSdk.emit('onRunningContextChange', { runningContext: 'inMainClient' });
  });

  /** An owner who left the meeting: the notes, the transcript and the way back to them are held. */
  async function holdingNotes(routes = {}) {
    const fetchMock = await open({
      [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...OWNER }),
      [arloPath('notes')]: () => json({ notes: NOTES }),
      ...routes,
    });
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Said while Arlo was here.'));
    await send(serverMessage.timelineEvent({ id: 'e1', eventType: 'joined', participantName: 'Bo', timestamp: 1000 }));
    await leaveMeeting();
    await waitFor(() => expect(arlo.afterNotesMeetingId).toBe(MEETING));
    expect(arlo.notes).toEqual(NOTES);
    expect(meeting.segments).toHaveLength(1);
    expect(meeting.participantEvents).toHaveLength(1);
    return fetchMock;
  }

  const expectNothingHeld = () => waitFor(() => {
    expect(arlo.notes).toBeNull();
    expect(arlo.role).toBeNull();
    expect(arlo.afterNotesMeetingId).toBeNull();
    expect(meeting.segments).toHaveLength(0);
    expect(meeting.participantEvents).toHaveLength(0);
  });

  test('signing out clears the held notes, the kept transcript and the way back to them', async () => {
    await holdingNotes();
    await act(async () => { auth.logout(); });
    await expectNothingHeld();
  });

  test('a lost session clears them too', async () => {
    let sessionValid = true;
    await holdingNotes({
      '/api/auth/me': () => (sessionValid
        ? json({ user: { id: 'user-1', displayName: 'Ana' } })
        : json({ error: 'Not authenticated' }, 401)),
      '/api/highlights': () => (sessionValid ? json({}) : json({ error: 'Unauthorized' }, 401)),
    });
    // The session ends (expiry, deauthorization): the next API call is refused
    sessionValid = false;
    await act(async () => { await fetch('/api/highlights', { credentials: 'include' }); });
    await waitFor(() => expect(auth.isAuthenticated).toBe(false));
    await expectNothingHeld();
  });

  test('another person signed in: nothing of the first person\'s is shown to them', async () => {
    await holdingNotes();
    await act(async () => { auth.login({ id: 'user-2', displayName: 'Ben' }); });
    await expectNothingHeld();
  });

  test('the same person confirmed again keeps everything', async () => {
    await holdingNotes();
    await act(async () => { await auth.checkAuth(); });
    await act(async () => { auth.login({ id: 'user-1', displayName: 'Ana' }); });
    expect(arlo.notes).toEqual(NOTES);
    expect(arlo.afterNotesMeetingId).toBe(MEETING);
    expect(meeting.segments).toHaveLength(1);
  });

  test('in a live meeting, notes pushed to a panel whose session ended are not kept', async () => {
    await asOwner();
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    await act(async () => { auth.logout(); });
    await waitFor(() => expect(arlo.notes).toBeNull());
    // The socket was opened as the owner and may still be sent the owner's messages
    await send(serverMessage.arloState(OWNER));
    await send(serverMessage.notes({ ...NOTES, summary: 'Sent after the session ended.', throughSeqNo: 30 }));
    expect(arlo.notes).toBeNull();
  });

  test('in a live meeting, a panel whose session ended is never an owner, whatever its old socket is told', async () => {
    const fetchMock = await asOwner();
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    await act(async () => { auth.logout(); });
    await waitFor(() => expect(auth.isAuthenticated).toBe(false));
    const notesAsked = callsTo(fetchMock, arloPath('notes')).length;

    await send(serverMessage.arloState({ ...OWNER, myStreamPaused: true }));
    // Arlo is here, and this person is a participant: no stream of theirs, no notes
    expect(arlo).toMatchObject({ loaded: true, present: true, role: 'participant', myStreamPaused: false, ownerName: 'Ana' });
    await send(serverMessage.notes({ ...NOTES, summary: 'Sent after the session ended.', throughSeqNo: 30 }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(arlo.role).toBe('participant');
    expect(arlo.notes).toBeNull();
    expect(callsTo(fetchMock, arloPath('notes'))).toHaveLength(notesAsked);
  });

  test('in a meeting that ended but was not left, signing out drops the kept transcript and timeline', async () => {
    await asOwner();
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Said while Arlo was here.'));
    await send(serverMessage.timelineEvent({ id: 'e1', eventType: 'joined', participantName: 'Bo', timestamp: 1000 }));
    await send(serverMessage.status('rtms_stopped', { meetingEnded: true }));
    // Still in the Zoom meeting: only the identity change can drop what is kept
    expect(meeting.meetingId).toBe(MEETING);
    expect(meeting.meetingEnded).toBe(true);
    expect(meeting.segments).toHaveLength(1);
    expect(meeting.participantEvents).toHaveLength(1);

    await act(async () => { auth.logout(); });
    await waitFor(() => {
      expect(arlo.notes).toBeNull();
      expect(meeting.segments).toHaveLength(0);
      expect(meeting.participantEvents).toHaveLength(0);
    });
  });

  test('in a meeting that is still running, signing out keeps the live transcript: everyone in it sees that', async () => {
    await asOwner();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Said while Arlo was here.'));
    await act(async () => { auth.logout(); });
    await waitFor(() => expect(arlo.notes).toBeNull());
    expect(meeting.segments).toHaveLength(1);
  });
});

describe('shared notes', () => {
  const SHARED = { present: true, role: 'participant', ownerName: 'Ana', notesShared: true };
  const NOT_SHARED = { ...SHARED, notesShared: false };
  const leaveMeeting = () => act(async () => {
    window.zoomSdk.emit('onRunningContextChange', { runningContext: 'inMainClient' });
  });

  test('notesShared is the server\'s word, false unless it says true', async () => {
    await open();
    expect(arlo.notesShared).toBe(false);
    await send(serverMessage.arloState(SHARED));
    expect(arlo.notesShared).toBe(true);
    for (const notTrue of ['true', 1, null, undefined]) {
      await send(serverMessage.arloState({ ...SHARED, notesShared: notTrue }));
      expect(arlo.notesShared).toBe(false);
    }
    await send(serverMessage.arloState(SHARED, 'ANOTHER-MEETING=='));
    expect(arlo.notesShared).toBe(false);
  });

  test('a participant holds notes only while they are shared: fetched when sharing starts, dropped when it stops', async () => {
    const fetchMock = await open({ [arloPath('notes')]: () => json({ notes: NOTES }) });
    await send(serverMessage.notes(NOTES));
    expect(arlo.notes).toBeNull();
    expect(callsTo(fetchMock, arloPath('notes'))).toHaveLength(0);

    await send(serverMessage.arloState(SHARED));
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    expect(arlo.role).toBe('participant');
    expect(callsTo(fetchMock, arloPath('notes'))).toHaveLength(1);
    await send(serverMessage.notes({ ...NOTES, summary: 'Newer.', throughSeqNo: 12 }));
    expect(arlo.notes.summary).toBe('Newer.');
    await send(serverMessage.notes({ ...NOTES, summary: 'Another meeting.', throughSeqNo: 40 }, 'ANOTHER-MEETING=='));
    expect(arlo.notes.summary).toBe('Newer.');

    await send(serverMessage.arloState(NOT_SHARED));
    expect(arlo.notes).toBeNull();
    await send(serverMessage.notes({ ...NOTES, summary: 'After it stopped.', throughSeqNo: 20 }));
    expect(arlo.notes).toBeNull();
  });

  test('an owner keeps the notes whether or not they are shared', async () => {
    await asOwner();
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    await send(serverMessage.arloState({ ...OWNER, notesShared: true }));
    expect(arlo.notes).toEqual(NOTES);
    await send(serverMessage.arloState({ ...OWNER, notesShared: false }));
    expect(arlo.notes).toEqual(NOTES);
    // no longer an owner, and nothing is shared: gone
    await send(serverMessage.arloState(NOT_SHARED));
    expect(arlo.notes).toBeNull();
  });

  test('setShareNotes sends the boolean, takes the server\'s state, and resolves to whether it worked', async () => {
    let refuse = false;
    const fetchMock = await open({
      [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...OWNER }),
      [`PUT ${arloPath('settings')}`]: ({ body }) => (refuse
        ? json({ error: 'Forbidden' }, 403)
        : json({ ...ARLO_ABSENT, ...OWNER, notesShared: body.shareNotes })),
    });
    const puts = () => fetchMock.mock.calls.filter(([url, init]) => String(url) === arloPath('settings') && init?.method === 'PUT');
    let result;
    await act(async () => { result = await arlo.setShareNotes(true); });
    expect(result).toBe(true);
    expect(arlo.notesShared).toBe(true);
    expect(puts().map(([, init]) => JSON.parse(init.body))).toEqual([{ shareNotes: true }]);
    puts().forEach(([, init]) => expect(init.credentials).toBe('include'));

    refuse = true;
    await act(async () => { result = await arlo.setShareNotes(false); });
    expect(result).toBe(false);
    expect(arlo.notesShared).toBe(true);
    // not a boolean: nothing is sent
    for (const bad of ['true', 1, null, undefined]) {
      await act(async () => { result = await arlo.setShareNotes(bad); });
      expect(result).toBe(false);
    }
    expect(puts()).toHaveLength(2);
  });

  test('a participant who left the meeting keeps the shared notes and the record; signing out clears them', async () => {
    await open({
      [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...SHARED }),
      [arloPath('notes')]: () => json({ notes: NOTES }),
    });
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'Said while Arlo was here.'));
    await leaveMeeting();
    await waitFor(() => expect(arlo.afterNotesMeetingId).toBe(MEETING));
    expect(arlo.notes).toEqual(NOTES);
    expect(meeting.segments).toHaveLength(1);

    await act(async () => { auth.logout(); });
    await waitFor(() => {
      expect(arlo.notes).toBeNull();
      expect(arlo.notesShared).toBe(false);
      expect(arlo.afterNotesMeetingId).toBeNull();
      expect(meeting.segments).toHaveLength(0);
    });
  });

  test('in a meeting that ended, the server\'s "nothing is shared" does not take the held notes away', async () => {
    await open({
      [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...SHARED }),
      [arloPath('notes')]: () => json({ notes: NOTES }),
    });
    await waitFor(() => expect(arlo.notes).toEqual(NOTES));
    await send(serverMessage.status('rtms_stopped', { meetingEnded: true }));
    await send(serverMessage.arloState({ present: false, role: 'participant', ownerName: null, notesShared: false }));
    expect(arlo.notes).toEqual(NOTES);
    expect(arlo.present).toBe(false);
  });
});

describe('myStreamLive', () => {
  test('is the server\'s word about whether this owner\'s own stream runs; null when it did not say', async () => {
    await asOwner();
    await send(serverMessage.arloState({ ...OWNER, myStreamLive: true }));
    expect(arlo.myStreamLive).toBe(true);
    await send(serverMessage.arloState({ ...OWNER, myStreamLive: false }));
    expect(arlo).toMatchObject({ present: true, role: 'owner', myStreamLive: false });
    await send(serverMessage.arloState({ ...OWNER }));
    expect(arlo.myStreamLive).toBeNull();
    await send(serverMessage.arloState({ ...OWNER, myStreamLive: 'yes' }));
    expect(arlo.myStreamLive).toBeNull();
  });

  test('is never kept for a participant', async () => {
    await asOwner();
    await send(serverMessage.arloState({ present: true, role: 'participant', ownerName: 'Ana', myStreamLive: true }));
    expect(arlo.myStreamLive).toBeNull();
  });
});
