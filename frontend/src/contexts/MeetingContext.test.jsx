import React, { useEffect } from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, resetHarness, serverMessage, arloPath, ARLO_ABSENT,
} from '../test/harness';
import { ZoomSdkProvider } from './ZoomSdkContext';
import { AuthProvider } from './AuthContext';
import { ServerSettingsProvider } from './ServerSettingsContext';
import { MeetingProvider, useMeeting } from './MeetingContext';

// The real providers in a fake Zoom meeting. The probe stands where a screen
// would: it opens the meeting socket and calls what a screen (or a timer of
// the provider itself) would call.

const ANA_BROUGHT_ARLO = { present: true, role: 'participant', ownerName: 'Ana' };

let meeting;
function Probe() {
  meeting = useMeeting();
  const { ws, meetingId, connectWebSocket } = meeting;
  useEffect(() => {
    if (!ws && meetingId) connectWebSocket(meetingId);
  }, [ws, meetingId, connectWebSocket]);
  return null;
}

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const startCalls = (sdk) => sdk.callZoomApi.mock.calls.filter(([name]) => name === 'startRTMS');
const socketOpen = () => waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));

/** A signed-in attendee's panel while Ana's Arlo runs in the meeting. */
async function openBesideAna() {
  mockFetch({ [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...ANA_BROUGHT_ARLO }) });
  const sdk = createZoomSdk({ role: 'attendee', screenName: 'Ben' });
  window.zoomSdk = sdk;
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.setItem('arlo-auto-start', 'false');
  render(
    <ZoomSdkProvider>
      <AuthProvider>
        <ServerSettingsProvider>
          <MeetingProvider>
            <Probe />
          </MeetingProvider>
        </ServerSettingsProvider>
      </AuthProvider>
    </ZoomSdkProvider>,
  );
  await socketOpen();
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
  await waitFor(() => expect(meeting.rtmsPhase).toBe('active'));
  return sdk;
}

/** The socket drops and the panel reconnects: a new socket, on which the server has said nothing yet. */
async function reconnect() {
  const sockets = FakeWebSocket.instances.length;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await act(async () => { server().close(1006); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
  vi.useRealTimers();
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(sockets + 1));
  await socketOpen();
}

afterEach(() => {
  vi.useRealTimers();
  resetHarness();
});

describe('a start beside another person\'s stream', () => {
  test('is only ever a person\'s own click: the automatic start never asks for one', async () => {
    const sdk = await openBesideAna();
    await act(async () => { await meeting.startRTMS(true); });
    expect(startCalls(sdk)).toHaveLength(0);
    expect(meeting.rtmsPhase).toBe('active');

    await act(async () => { await meeting.startRTMS(false); });
    expect(startCalls(sdk)).toHaveLength(1);
    expect(meeting.rtmsPhase).toBe('requested');
  });

  test('on a new socket nothing is taken from the old one: no start beside a stream until the server says again whose it is', async () => {
    const sdk = await openBesideAna();
    await reconnect();
    // The server has not said on this socket what this person is to Arlo:
    // the running stream may be their own by now
    await act(async () => { await meeting.startRTMS(false); });
    expect(startCalls(sdk)).toHaveLength(0);
    expect(meeting.rtmsPhase).toBe('active');

    await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
    await act(async () => { await meeting.startRTMS(false); });
    expect(startCalls(sdk)).toHaveLength(1);
  });

  test('asked again on a new socket before the server spoke, after one that ended: still beside the other stream', async () => {
    const sdk = await openBesideAna();
    await act(async () => { await meeting.startRTMS(false); });
    await send(serverMessage.requestStatus(3)); // the host declined
    await waitFor(() => expect(meeting.rtmsPhase).toBe('denied'));

    await reconnect();
    await act(async () => { await meeting.startRTMS(false); });
    expect(startCalls(sdk)).toHaveLength(2);
    expect(meeting.rtmsPhase).toBe('requested');

    // Ana's stream goes on: not this person's
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.segment(1, 'said through the other stream'));
    await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(meeting.rtmsPhase).toBe('requested');
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
  });
});
