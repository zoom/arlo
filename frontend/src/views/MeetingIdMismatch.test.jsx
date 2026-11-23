import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, renderClassic, resetHarness,
  serverMessage, serverMessagesFor, arloPath, ARLO_ABSENT, MEETING,
} from '../test/harness';

// The Zoom SDK and the server can know one meeting by two ids: the panel reads
// its id from the SDK (with fallbacks, down to the numeric meeting id), the
// server takes it from the verified app context and stamps every socket
// message with it. The panel must follow the server's id for everything it
// asks the server and everything it accepts from it.

const SDK_ID = '86412345678'; // the SDK's last fallback: the numeric meeting id
const SERVER_ID = 'SERVER-UUID/abc+1==';
const THIRD_ID = 'THIRD-MEETING==';
const fromServer = serverMessagesFor(SERVER_ID);
const fromThird = serverMessagesFor(THIRD_ID);
const NOTES = {
  summary: 'The beta moves to March 3 so billing can finish first.',
  decisions: ['Beta launch moves to March 3'],
  actionItems: [{ text: 'Send the revised timeline', owner: 'Ana' }],
  updatedAt: '2026-11-23T12:00:00.000Z',
  throughSeqNo: 9,
};
const OWNER = { present: true, role: 'owner', ownerName: 'Ana' };

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const socketOpen = () => waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
const byZoomId = (meetingId) => `/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}`;
const urlsOf = (fetchMock) => fetchMock.mock.calls.map(([url]) => String(url));
const mismatchWarnings = (warn) => warn.mock.calls.filter(([line]) => /differs from the one the server verified/.test(String(line)));

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  resetHarness();
});

describe('the SDK reports one meeting id, the server verified another', () => {
  const open = (render, routes = {}) => {
    const fetchMock = mockFetch(routes, { serverMeetingId: SERVER_ID });
    const result = render({ sdk: createZoomSdk({ meetingUUID: SDK_ID }), routeMeetingId: SDK_ID });
    return { fetchMock, ...result };
  };

  test('the live transcript and status for the server\'s id are shown, and history is asked for by it', async () => {
    const { fetchMock } = open(renderClassic, {
      [`${byZoomId(SERVER_ID)}/transcript`]: () => json({
        segments: [fromServer.segment(1, 'Said before this panel opened.').data.segment],
      }),
    });
    await socketOpen();

    await send(fromServer.status('rtms_started'));
    await send(fromServer.segment(2, 'Said live, under the id the server uses.'));
    expect(await screen.findByText('Said live, under the id the server uses.')).toBeInTheDocument();
    expect(await screen.findByText('Said before this panel opened.')).toBeInTheDocument();
    expect(screen.getByText('Transcribing')).toBeInTheDocument();

    const urls = urlsOf(fetchMock);
    expect(urls).toContain(`${byZoomId(SERVER_ID)}/transcript`);
    expect(urls).toContain(`${byZoomId(SERVER_ID)}/participant-events`);
    // Nothing is asked of the server under the id only the SDK knows
    expect(urls.filter((url) => url.startsWith(byZoomId(SDK_ID)))).toEqual([]);
    // The socket subscribes to the verified meeting
    expect(server().sent[0]).toMatchObject({ type: 'subscribe', payload: { meetingId: SERVER_ID } });
  });

  test('a message for a third meeting is still ignored, and so is one under the SDK\'s own id', async () => {
    open(renderClassic);
    await socketOpen();
    await send(fromServer.status('rtms_started'));
    await send(fromServer.segment(1, 'A line of this meeting.'));
    await screen.findByText('A line of this meeting.');

    await send(fromThird.segment(2, 'A line of a third meeting.'));
    await send(serverMessagesFor(SDK_ID).segment(3, 'A line nobody verified.'));
    await send(fromThird.status('rtms_stopped', { meetingEnded: true }));

    expect(screen.queryByText('A line of a third meeting.')).not.toBeInTheDocument();
    expect(screen.queryByText('A line nobody verified.')).not.toBeInTheDocument();
    expect(screen.getByText('Transcribing')).toBeInTheDocument();
  });

  test('Arlo\'s state and the owner\'s notes come from the server\'s id, and a status post names it', async () => {
    let posted;
    const { fetchMock, sdk } = open(renderInMeeting, {
      'POST /api/rtms/status': ({ body }) => { posted = body; return json({}); },
    });
    await socketOpen();
    // Not an owner yet: the state route (under the server's id) said so
    await waitFor(() => expect(urlsOf(fetchMock)).toContain(arloPath('state', SERVER_ID)));

    await send(fromServer.status('rtms_started'));
    await send(fromServer.arloState(OWNER));
    expect(await screen.findByText('Arlo is in the meeting')).toBeInTheDocument();
    await send(fromServer.notes(NOTES));
    expect(await screen.findByText(NOTES.summary)).toBeInTheDocument();
    expect(urlsOf(fetchMock)).toContain(arloPath('notes', SERVER_ID));

    // Another meeting's state and notes change nothing
    await send(fromThird.arloState({ ...ARLO_ABSENT }));
    await send(fromThird.notes({ ...NOTES, summary: 'Notes of a third meeting.', throughSeqNo: 20 }));
    expect(screen.queryByText('Notes of a third meeting.')).not.toBeInTheDocument();
    expect(screen.getByText(NOTES.summary)).toBeInTheDocument();
    expect(screen.getByText('Arlo is in the meeting')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(sdk.pauseRTMS).toHaveBeenCalledTimes(1);
    await send(fromServer.status('rtms_paused'));
    await waitFor(() => expect(posted).toEqual({ meetingId: SERVER_ID, status: 'rtms_paused' }));

    expect(urlsOf(fetchMock).filter((url) => url.startsWith(byZoomId(SDK_ID)))).toEqual([]);
    // The address keeps the id the SDK reports
    expect(window.location.hash).toBe(`#/meeting/${encodeURIComponent(SDK_ID)}`);
  });

  test('the difference is reported once, without the ids', async () => {
    open(renderClassic);
    await socketOpen();
    const first = server();
    expect(mismatchWarnings(warn)).toHaveLength(1);
    expect(JSON.stringify(mismatchWarnings(warn)[0])).not.toContain(SDK_ID);
    expect(JSON.stringify(mismatchWarnings(warn)[0])).not.toContain(SERVER_ID);

    // A reconnect verifies access again: the same difference is not reported twice
    await act(async () => { first.close(1006); });
    await waitFor(() => {
      expect(server()).not.toBe(first);
      expect(server().readyState).toBe(FakeWebSocket.OPEN);
    }, { timeout: 8000 });
    expect(mismatchWarnings(warn)).toHaveLength(1);
  }, 15000);
});

describe('the SDK and the server agree (every normal meeting)', () => {
  test('nothing is reported, and the transcript is live as before', async () => {
    const fetchMock = mockFetch();
    renderClassic();
    await socketOpen();
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'A line of this meeting.'));

    expect(await screen.findByText('A line of this meeting.')).toBeInTheDocument();
    expect(urlsOf(fetchMock)).toContain(`${byZoomId(MEETING)}/transcript`);
    expect(mismatchWarnings(warn)).toHaveLength(0);
  });
});
