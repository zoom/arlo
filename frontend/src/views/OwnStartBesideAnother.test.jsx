import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage,
  arloPath, ARLO_ABSENT,
} from '../test/harness';
import { STALLED_MESSAGE } from '../lib/rtmsMachine';

// A start made beside someone else's stream is this panel's stream only when
// the server says so. Until then nothing may act as if it were: not Zoom's
// indicator (everyone in the meeting sees it), not the restart after a fault
// (a startRTMS nobody clicked), not the notice in the meeting chat.
// Driven through the real app in a fake Zoom meeting.

const OWNER = { present: true, role: 'owner', ownerName: 'Ana' };
const ANA_BROUGHT_ARLO = { present: true, role: 'participant', ownerName: 'Ana' };
const ME_TOO = { ...OWNER, myStreamLive: true };
const MINE_STOPPED = { ...OWNER, myStreamLive: false };
const USE = 'Take notes yourself';

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const startCalls = (sdk) => sdk.callZoomApi.mock.calls.filter(([name]) => name === 'startRTMS');
const lastIndicator = (sdk) => sdk.setDynamicIndicator.mock.calls.at(-1)?.[0]?.text;
const alreadyRunning = async () => { throw Object.assign(new Error('RTMS is already running'), { code: '10308' }); };
/** Let the app's timers run for this long (fake timers must be on). */
const pass = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Clicks while the app's timers are faked. */
const fakeTimersAndUser = () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
};
const warnedWith = (sdk, message) => sdk.showNotification.mock.calls.some(([arg]) => arg?.message === message);

/** The meeting chat notices a user turns on in Settings: without them no assertion about the chat means anything. */
function turnChatNoticesOn() {
  localStorage.setItem('arlo-chat-notices', JSON.stringify({
    enabled: true,
    events: { start: true, pause: true, resume: true, stop: true, restart: true },
  }));
}

async function open({ sdk, state, routes = {} } = {}) {
  mockFetch({ [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }), ...routes });
  const result = renderInMeeting({ sdk });
  // renderInMeeting clears nothing in localStorage but its own keys
  turnChatNoticesOn();
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  return result;
}

/** A signed-in attendee's panel while Ana's Arlo runs in the meeting. */
async function openBesideAna(sdkOptions = {}) {
  const sdk = createZoomSdk({ role: 'attendee', screenName: 'Ben', ...sdkOptions });
  const result = await open({ sdk, state: ANA_BROUGHT_ARLO });
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
  await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
  return result;
}

/** What Ana's stream does next: a line, a status, and the state every panel is sent. */
async function anasStreamGoesOn(seqNo, state = ANA_BROUGHT_ARLO) {
  await send(serverMessage.segment(seqNo, 'said through the other stream'));
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.arloState(state));
}
async function anasStreamFaults(state = ANA_BROUGHT_ARLO) {
  await send(serverMessage.status('rtms_stopped', { fault: true }));
  await send(serverMessage.arloState({ ...state, present: false }));
}

beforeEach(turnChatNoticesOn);
afterEach(() => {
  vi.useRealTimers();
  resetHarness();
});

describe('"Take notes yourself" that never becomes a stream of one\'s own', () => {
  test('Zoom answers "already running" (10308): the other stream is never taken for this panel\'s', async () => {
    const { sdk } = await openBesideAna({ startRTMS: alreadyRunning });
    const user = fakeTimersAndUser();
    await user.click(await screen.findByRole('button', { name: USE }));
    expect(startCalls(sdk)).toHaveLength(1);

    // Ana's stream delivers while this start waits, then the wait runs out
    await anasStreamGoesOn(1);
    await pass(16000);
    expect(warnedWith(sdk, STALLED_MESSAGE)).toBe(true);
    // not asked again on its own: "already running" was about Ana's stream
    expect(startCalls(sdk)).toHaveLength(1);

    // Ana's next line and status show Arlo is here: through her stream
    await anasStreamGoesOn(2);
    await send(serverMessage.status('rtms_paused'));
    await send(serverMessage.status('rtms_resumed'));
    await anasStreamGoesOn(3);
    await pass(200);
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();

    // her stream ends by a fault: hers to restart, not this panel's
    await anasStreamFaults();
    await pass(10000);
    expect(startCalls(sdk)).toHaveLength(1);
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  }, 20000);

  test('Zoom says "started" and no stream of one\'s own follows: the same, also when the other stream faults meanwhile', async () => {
    const { sdk } = await openBesideAna();
    const user = fakeTimersAndUser();
    await user.click(await screen.findByRole('button', { name: USE }));
    await screen.findByText(/Waiting for the host to allow Arlo…/);
    await act(async () => { sdk.emit('onRTMSStatusChange', { status: 'started' }); });
    await screen.findByText('Bringing Arlo in…');

    await anasStreamGoesOn(1);
    await anasStreamFaults();
    await pass(10000);
    expect(startCalls(sdk)).toHaveLength(1);
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  }, 20000);

  test('Zoom answers nothing and the request expires: the same', async () => {
    const { sdk } = await openBesideAna();
    const user = fakeTimersAndUser();
    await user.click(await screen.findByRole('button', { name: USE }));
    await screen.findByText(/Waiting for the host to allow Arlo…/);

    await pass(61000);
    await anasStreamGoesOn(1);
    await pass(200);
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    await anasStreamFaults();
    await pass(10000);
    expect(startCalls(sdk)).toHaveLength(1);
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
  }, 20000);
});

describe('an owner\'s "Bring Arlo back" while Arlo is here through another person\'s stream (no "Take notes yourself" in this deployment)', () => {
  test('Zoom answers "already running": the other stream is never taken for this owner\'s', async () => {
    const sdk = createZoomSdk({ startRTMS: alreadyRunning });
    await open({
      sdk,
      state: MINE_STOPPED,
      routes: { '/api/auth/settings': () => json({ demoMode: true, features: { autoStart: false } }) },
    });
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState(MINE_STOPPED));
    const user = fakeTimersAndUser();
    await user.click(await screen.findByRole('button', { name: 'Bring Arlo back' }));
    expect(startCalls(sdk)).toHaveLength(1);

    await pass(16000);
    expect(warnedWith(sdk, STALLED_MESSAGE)).toBe(true);
    expect(startCalls(sdk)).toHaveLength(1);

    await anasStreamGoesOn(1, MINE_STOPPED);
    await anasStreamGoesOn(2, MINE_STOPPED);
    await pass(200);
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();

    await anasStreamFaults(MINE_STOPPED);
    await pass(10000);
    expect(startCalls(sdk)).toHaveLength(1);
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  }, 20000);
});

describe('a start of one\'s own that the server confirms', () => {
  test('beside another stream: nothing before the server\'s word, then the indicator and one chat notice', async () => {
    const { sdk } = await openBesideAna();
    await userEvent.click(await screen.findByRole('button', { name: USE }));
    await screen.findByText(/Waiting for the host to allow Arlo…/);

    // Ana's lines while the request waits are not this person's stream
    await anasStreamGoesOn(1);
    await anasStreamGoesOn(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(sdk.setDynamicIndicator).not.toHaveBeenCalled();

    await send(serverMessage.arloState(ME_TOO));
    await waitFor(() => expect(lastIndicator(sdk)).toBe('Arlo is transcribing'));
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    await send(serverMessage.segment(3, 'the first line since'));
    await send(serverMessage.segment(4, 'and another'));
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    expect(sdk.sendMessageToChat.mock.calls[0][0].message).toMatch(/^I'm using a Zoom app, Arlo/);
    expect(startCalls(sdk)).toHaveLength(1);
  });

  test('a reloaded panel never clicked: the server says this owner\'s own stream runs, so the indicator is set again, and nothing else', async () => {
    const sdk = createZoomSdk();
    await open({ sdk, state: { ...OWNER, myStreamLive: true } });
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState({ ...OWNER, myStreamLive: true }));
    await waitFor(() => expect(lastIndicator(sdk)).toBe('Arlo is transcribing'));
    await send(serverMessage.segment(1, 'a line after the reload'));
    await send(serverMessage.segment(2, 'and another'));
    expect(startCalls(sdk)).toHaveLength(0);
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();

    // the stream stops: the indicator goes
    await send(serverMessage.status('rtms_stopped'));
    await send(serverMessage.arloState({ ...OWNER, present: false, myStreamLive: false }));
    await waitFor(() => expect(sdk.removeDynamicIndicator).toHaveBeenCalled());
  });

  test('alone in the meeting, as before: the indicator, one chat notice, and the restart after a fault', async () => {
    const sdk = createZoomSdk();
    await open({ sdk });
    await userEvent.click(await screen.findByRole('button', { name: 'Bring Arlo into this meeting' }));
    expect(startCalls(sdk)).toHaveLength(1);
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState(OWNER));
    await waitFor(() => expect(lastIndicator(sdk)).toBe('Arlo is transcribing'));
    await send(serverMessage.segment(1, 'the first line'));
    await send(serverMessage.segment(2, 'the second'));
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);

    await send(serverMessage.status('rtms_stopped', { fault: true }));
    await send(serverMessage.arloState({ ...OWNER, present: false }));
    await waitFor(() => expect(startCalls(sdk)).toHaveLength(2), { timeout: 4000 });

    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState(OWNER));
    await waitFor(() => expect(sdk.setDynamicIndicator).toHaveBeenCalledTimes(2));
    expect(lastIndicator(sdk)).toBe('Arlo is transcribing');
  }, 15000);

  test('alone in the meeting, Zoom says "already running" and the stream then shows: it is this panel\'s, as before', async () => {
    const sdk = createZoomSdk({ startRTMS: alreadyRunning });
    await open({ sdk });
    await userEvent.click(await screen.findByRole('button', { name: 'Bring Arlo into this meeting' }));
    await send(serverMessage.status('rtms_started'));
    await send(serverMessage.arloState(OWNER));
    await waitFor(() => expect(lastIndicator(sdk)).toBe('Arlo is transcribing'));
    await send(serverMessage.segment(1, 'the first line'));
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
  });
});
