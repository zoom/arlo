import { screen, waitFor, act } from '@testing-library/react';
import { vi } from 'vitest';
import {
  createZoomSdk, FakeWebSocket, json, mockFetch, renderInMeeting, resetHarness, serverMessage, serverMessagesFor,
  arloPath, ARLO_ABSENT,
} from '../test/harness';

// The panel as Arlo's hands: an owner's panel tells the server what it can do
// with the Zoom Apps SDK, runs the actions the server sends it, once each,
// and reports how each went. Driven through the real app in a fake meeting.

const OWNER = { present: true, role: 'owner', ownerName: 'Ana', myStreamLive: true };
const ANA_BROUGHT_ARLO = { present: true, role: 'participant', ownerName: 'Ana', whoCanAsk: 'anyone' };
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const A2 = 'aaaaaaaa-2222-4222-8222-222222222222';
const HOST_HANDS = ['post_to_chat', 'admit_from_waiting_room', 'invite_everyone', 'send_reaction', 'mute_participant'];
const ATTENDEE_HANDS = ['post_to_chat', 'invite_everyone', 'send_reaction'];
const CHAT = { tool: 'post_to_chat', args: { message: 'The beta moves to March 3.' } };

const server = () => FakeWebSocket.last;
const send = (message) => act(async () => { server().serverSend(message); });
const hands = (socket = server()) => socket.sent.filter((message) => message.type === 'arlo.hands');
const lastHands = () => hands().at(-1)?.payload;
/** What the panel reported for its actions: [{ actionId, body }]. */
const results = (fetchMock) => fetchMock.mock.calls
  .filter(([url, init]) => String(url).startsWith(arloPath('actions/')) && init?.method === 'POST')
  .map(([url, init]) => ({ actionId: String(url).split('/').at(-2), body: JSON.parse(init.body), init }));
const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); });

async function open({ sdk, guest = false, state = OWNER, routes = {} } = {}) {
  const fetchMock = mockFetch({ [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...state }), ...routes }, { signedIn: !guest });
  const result = renderInMeeting({ sdk, guest });
  await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
  await send(serverMessage.subscribed());
  await send(serverMessage.status('rtms_started'));
  await send(serverMessage.arloState(state));
  return { ...result, fetchMock };
}
async function openAsOwner(options = {}) {
  const result = await open(options);
  await screen.findByText('Arlo is in the meeting');
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHarness();
});

describe('what the panel says it can do', () => {
  test('an owner who is the host: everything this panel can do, after the subscription', async () => {
    await openAsOwner();
    await waitFor(() => expect(hands()).toHaveLength(1));
    expect(hands()[0]).toEqual({ type: 'arlo.hands', payload: { zoomRole: 'host', can: HOST_HANDS } });
    const sent = server().sent.map((message) => message.type);
    expect(sent.indexOf('subscribe')).toBeLessThan(sent.indexOf('arlo.hands'));
  });

  test('nothing is announced before the server spoke on the socket', async () => {
    mockFetch({ [arloPath('state')]: () => json({ ...ARLO_ABSENT, ...OWNER }) });
    renderInMeeting();
    await waitFor(() => expect(server()?.readyState).toBe(FakeWebSocket.OPEN));
    await screen.findByText('Arlo is in the meeting');
    await settle();
    expect(hands()).toHaveLength(0);
    await send(serverMessage.subscribed());
    await waitFor(() => expect(hands()).toHaveLength(1));
  });

  test.each([
    ['a co-host announces the waiting room and muting too', 'coHost', HOST_HANDS],
    ['an attendee who owns a stream announces the chat, the invitation and a reaction', 'attendee', ATTENDEE_HANDS],
  ])('%s', async (_name, role, can) => {
    await openAsOwner({ sdk: createZoomSdk({ role }) });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: role, can }));
  });

  test('a host whose Zoom client has no waiting-room APIs does not announce that tool', async () => {
    const sdk = createZoomSdk({ waitingRoomApis: false });
    await openAsOwner({ sdk });
    // The tiers asked for after the waiting room (muting, reactions) go with it
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'host', can: ['post_to_chat', 'invite_everyone'] }));
    // The rest of what the client accepts is kept: Zoom's indicator APIs are still asked for
    expect(sdk.config.mock.calls.at(-1)[0].capabilities).toContain('setDynamicIndicator');
    expect(sdk.config.mock.calls.at(-1)[0].capabilities).not.toContain('getWaitingRoomParticipants');
  });

  test('the waiting-room APIs refused at config, though the client object has the methods: that tool is not announced', async () => {
    const sdk = createZoomSdk({ waitingRoomRefused: true });
    expect(typeof sdk.admitParticipantFromWaitingRoom).toBe('function');
    await openAsOwner({ sdk });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'host', can: ['post_to_chat', 'invite_everyone'] }));
    await settle();
    expect(hands()).toHaveLength(1);
  });

  test.each([
    ['the reaction APIs', ['setEmojiReaction'], ['post_to_chat', 'admit_from_waiting_room', 'invite_everyone', 'mute_participant']],
    ['the participant-audio API', ['toggleParticipantMediaAudio'], ['post_to_chat', 'admit_from_waiting_room', 'invite_everyone']],
  ])('%s refused at config: what the client had before is still announced', async (_name, refusedApis, can) => {
    await openAsOwner({ sdk: createZoomSdk({ refusedApis }) });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'host', can }));
    await settle();
    expect(hands()).toHaveLength(1);
  });

  test.each([
    ['the waiting-room list', 'getWaitingRoomParticipants', HOST_HANDS.filter((tool) => tool !== 'admit_from_waiting_room')],
    ['admitting', 'admitParticipantFromWaitingRoom', HOST_HANDS.filter((tool) => tool !== 'admit_from_waiting_room')],
    ['the chat', 'sendMessageToChat', HOST_HANDS.filter((tool) => tool !== 'post_to_chat')],
    ['the invitation', 'sendAppInvitationToAllParticipants', HOST_HANDS.filter((tool) => tool !== 'invite_everyone')],
    ['a reaction', 'setEmojiReaction', HOST_HANDS.filter((tool) => tool !== 'send_reaction')],
    ['muting', 'toggleParticipantMediaAudio', HOST_HANDS.filter((tool) => tool !== 'mute_participant')],
    ['the list of participants', 'getMeetingParticipants', HOST_HANDS.filter((tool) => tool !== 'mute_participant')],
  ])('Zoom accepts the configuration and says it lacks %s: that tool is not announced', async (_name, api, can) => {
    await openAsOwner({ sdk: createZoomSdk({ unsupportedApis: [api] }) });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'host', can }));
    await settle();
    expect(hands()).toHaveLength(1);
  });

  test('the Zoom role changes: the announcement follows', async () => {
    const { sdk } = await openAsOwner({ sdk: createZoomSdk({ role: 'attendee' }) });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'attendee', can: ATTENDEE_HANDS }));
    await act(async () => { sdk.emit('onMyUserContextChange', { role: 'coHost' }); });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'coHost', can: HOST_HANDS }));
    expect(hands()).toHaveLength(2);
  });

  test('a participant announces nothing; one who becomes an owner does; one who stops being one clears it', async () => {
    await open({ sdk: createZoomSdk({ role: 'attendee', screenName: 'Ben' }), state: ANA_BROUGHT_ARLO });
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    await settle();
    expect(hands()).toHaveLength(0);

    await send(serverMessage.arloState(OWNER));
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'attendee', can: ATTENDEE_HANDS }));

    await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'attendee', can: [] }));
    expect(hands()).toHaveLength(2);
  });

  test('a guest announces nothing, whatever the server says their role is', async () => {
    await open({ guest: true, sdk: createZoomSdk({ status: 'authenticated', role: 'host' }), state: OWNER });
    await screen.findByRole('heading', { name: /Arlo/ });
    await settle();
    expect(hands()).toHaveLength(0);
  });

  test('a new socket is told again', async () => {
    await openAsOwner();
    await waitFor(() => expect(hands()).toHaveLength(1));
    const first = server();
    await act(async () => { first.close(1006); });
    // The panel reconnects by itself after 5 seconds
    await waitFor(() => expect(server()).not.toBe(first), { timeout: 8000 });
    await waitFor(() => expect(server().readyState).toBe(FakeWebSocket.OPEN));
    expect(hands()).toHaveLength(0);
    await send(serverMessage.subscribed());
    await waitFor(() => expect(hands()).toHaveLength(1));
    expect(lastHands()).toEqual({ zoomRole: 'host', can: HOST_HANDS });
  }, 12000);
});

describe('an action from the server', () => {
  test('post to chat: the SDK is called once and the result is reported', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.action({ actionId: A1, ...CHAT }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    expect(sdk.sendMessageToChat).toHaveBeenCalledWith({ message: 'The beta moves to March 3.' });
    const [reported] = results(fetchMock);
    expect(reported.actionId).toBe(A1);
    expect(reported.body).toEqual({ ok: true });
    expect(reported.init.credentials).toBe('include');
    expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes('/actions/'))[0])).toBe(arloPath(`actions/${A1}/result`));
  });

  test('the same action again is ignored; another one runs', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.action({ actionId: A1, ...CHAT }));
    await send(serverMessage.action({ actionId: A1, ...CHAT }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    await send(serverMessage.action({ actionId: A1, ...CHAT }));
    await settle();
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    expect(results(fetchMock)).toHaveLength(1);

    await send(serverMessage.action({ actionId: A2, ...CHAT }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(2));
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(2);
  });

  describe('the report of a result that does not reach the server', () => {
    const tick = (ms) => act(async () => { vi.advanceTimersByTime(ms); });
    /** The result route answers with each of `answers` in turn, then takes the report. */
    const resultRoute = (answers) => {
      const left = [...answers];
      return {
        [`POST ${arloPath('actions/')}`]: () => {
          const next = left.shift();
          if (next === 'network') throw new TypeError('Failed to fetch');
          return next === undefined ? json({ received: true }) : json({ error: 'x' }, next);
        },
      };
    };
    async function reported(answers, options = {}) {
      const opened = await openAsOwner({ routes: resultRoute(answers), ...options });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await send(serverMessage.action({ actionId: A1, ...CHAT }));
      await waitFor(() => expect(results(opened.fetchMock)).toHaveLength(1));
      return opened;
    }

    test('is sent again after 1, 3 and 7 seconds, with the same result, and Zoom is not asked again', async () => {
      const { sdk, fetchMock } = await reported(['network', 503, 500]);
      await tick(900);
      expect(results(fetchMock)).toHaveLength(1);
      await tick(200);
      await waitFor(() => expect(results(fetchMock)).toHaveLength(2));
      await tick(2900);
      expect(results(fetchMock)).toHaveLength(2);
      await tick(200);
      await waitFor(() => expect(results(fetchMock)).toHaveLength(3));
      await tick(6900);
      expect(results(fetchMock)).toHaveLength(3);
      await tick(200);
      await waitFor(() => expect(results(fetchMock)).toHaveLength(4));
      expect(results(fetchMock).map((one) => one.body)).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
      expect(results(fetchMock).every((one) => one.actionId === A1)).toBe(true);
      expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    });

    test('stops once the server took it', async () => {
      const { sdk, fetchMock } = await reported([500]);
      await tick(1100);
      await waitFor(() => expect(results(fetchMock)).toHaveLength(2));
      await tick(30000);
      expect(results(fetchMock)).toHaveLength(2);
      expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    });

    test('is given up after three more tries', async () => {
      const { sdk, fetchMock } = await reported([500, 500, 500, 500, 500, 500]);
      await tick(1100);
      await tick(3100);
      await tick(7100);
      await waitFor(() => expect(results(fetchMock)).toHaveLength(4));
      await tick(60000);
      expect(results(fetchMock)).toHaveLength(4);
      expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    });

    test('a failed result is reported again as it was', async () => {
      const sdk = createZoomSdk();
      sdk.sendMessageToChat.mockRejectedValue(new Error('chat is off'));
      const { fetchMock } = await reported([502], { sdk });
      await tick(1100);
      await waitFor(() => expect(results(fetchMock)).toHaveLength(2));
      expect(results(fetchMock).map((one) => one.body)).toEqual([{ ok: false, code: 'sdk_error' }, { ok: false, code: 'sdk_error' }]);
      expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    });

    test.each([400, 403, 404, 409])('a refusal (%i) is the server\'s answer: not sent again', async (status) => {
      const { fetchMock } = await reported([status]);
      await tick(30000);
      expect(results(fetchMock)).toHaveLength(1);
    });

    test('is not sent again by a panel that is no longer an owner\'s', async () => {
      const { fetchMock } = await reported([500, 500]);
      await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
      await tick(30000);
      expect(results(fetchMock)).toHaveLength(1);
    });

    test('the same action sent again while its report is retried is still not run again', async () => {
      const { sdk, fetchMock } = await reported([500]);
      await send(serverMessage.action({ actionId: A1, ...CHAT }));
      await tick(1100);
      await waitFor(() => expect(results(fetchMock)).toHaveLength(2));
      expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    });
  });

  test('Zoom refuses: { ok: false, code: "sdk_error" }, and nothing about it is logged', async () => {
    const logs = ['log', 'warn', 'error'].map((level) => vi.spyOn(console, level));
    const sdk = createZoomSdk();
    sdk.sendMessageToChat.mockRejectedValue(new Error('The beta moves to March 3. could not be sent'));
    const { fetchMock } = await openAsOwner({ sdk });
    await send(serverMessage.action({ actionId: A1, ...CHAT }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(results(fetchMock)[0].body).toEqual({ ok: false, code: 'sdk_error' });
    const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls.map((call) => call.map(String))));
    expect(logged).not.toContain('March 3');
  });

  test('a tool this panel does not have: "unsupported"', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.action({ actionId: A1, tool: 'open_breakout_rooms', args: {} }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(results(fetchMock)[0].body).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('admit from the waiting room: the one person by that whole name is admitted', async () => {
    const sdk = createZoomSdk({ waitingRoom: [{ screenName: 'James Smith', participantUUID: 'W-1' }, { screenName: 'Bo', participantUUID: 'W-2' }] });
    const { fetchMock } = await openAsOwner({ sdk });
    await send(serverMessage.action({ actionId: A1, tool: 'admit_from_waiting_room', args: { name: 'james smith' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledTimes(1);
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'W-1' });
    expect(results(fetchMock)[0].body).toEqual({ ok: true });

    await send(serverMessage.action({ actionId: A2, tool: 'admit_from_waiting_room', args: { name: 'Noor' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(2));
    expect(results(fetchMock)[1].body).toEqual({ ok: false, code: 'not_found' });
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledTimes(1);
  });

  test('a first name is not enough: the only "Sam" waiting is not let in, and Arlo is told several match', async () => {
    const sdk = createZoomSdk({ waitingRoom: [{ screenName: 'Sam Stranger', participantUUID: 'W-1' }] });
    const { fetchMock } = await openAsOwner({ sdk });
    await send(serverMessage.action({ actionId: A1, tool: 'admit_from_waiting_room', args: { name: 'Sam' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(results(fetchMock)[0].body).toEqual({ ok: false, code: 'several_match' });
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
  });

  describe('what changed while Zoom was listing the waiting room', () => {
    /** An admit whose waiting-room list is held back until `release()`. */
    async function admitHeld(options = {}) {
      const sdk = createZoomSdk({ waitingRoom: [{ screenName: 'James', participantUUID: 'W-1' }] });
      let release;
      sdk.getWaitingRoomParticipants.mockImplementation(() => new Promise((resolve) => {
        release = () => resolve({ participants: [{ screenName: 'James', participantUUID: 'W-1' }] });
      }));
      const opened = await openAsOwner({ sdk, ...options });
      await send(serverMessage.action({ actionId: A1, tool: 'admit_from_waiting_room', args: { name: 'James' } }));
      await waitFor(() => expect(sdk.getWaitingRoomParticipants).toHaveBeenCalledTimes(1));
      return { ...opened, sdk, release: () => act(async () => { release(); }) };
    }

    test('nothing: the person is admitted', async () => {
      const { sdk, fetchMock, release } = await admitHeld();
      await release();
      await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
      expect(results(fetchMock)[0].body).toEqual({ ok: true });
      expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'W-1' });
    });

    test('this person is no longer an owner: nobody is admitted, "not_allowed"', async () => {
      const { sdk, fetchMock, release } = await admitHeld();
      await send(serverMessage.arloState(ANA_BROUGHT_ARLO));
      await release();
      await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
      expect(results(fetchMock)[0].body).toEqual({ ok: false, code: 'not_allowed' });
      expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    });

    test('the meeting ended: nobody is admitted', async () => {
      const { sdk, release } = await admitHeld();
      await send(serverMessage.status('rtms_stopped', { meetingEnded: true }));
      await release();
      await settle();
      expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    });

    test('the session ended: nobody is admitted', async () => {
      let sessionValid = true;
      const { sdk, release } = await admitHeld({
        routes: {
          '/api/auth/me': () => (sessionValid ? json({ user: { id: 'user-1', displayName: 'Ana' } }) : json({ error: 'Not authenticated' }, 401)),
          '/api/highlights': () => json({ error: 'Unauthorized' }, 401),
        },
      });
      sessionValid = false;
      await act(async () => { await fetch('/api/highlights', { credentials: 'include' }); });
      await waitFor(() => expect(screen.queryByText('Arlo is in the meeting')).not.toBeInTheDocument());
      await release();
      await settle();
      expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    });

    test('the panel is in another meeting: nobody is admitted', async () => {
      const { sdk, release } = await admitHeld();
      await act(async () => {
        sdk.getMeetingUUID.mockResolvedValue({ meetingUUID: 'MEETING-2==' });
        sdk.emit('onRunningContextChange', { runningContext: 'inMeeting' });
      });
      await release();
      await settle();
      expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    });
  });

  test('invite everyone: the app invitation goes out once and the result is reported', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.action({ actionId: A1, tool: 'invite_everyone', args: {} }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(sdk.sendAppInvitationToAllParticipants).toHaveBeenCalledTimes(1);
    expect(results(fetchMock)[0].body).toEqual({ ok: true });
  });

  test('send a reaction: the emoji of the panel\'s own table, and an unknown one is not sent', async () => {
    const { sdk, fetchMock } = await openAsOwner({ sdk: createZoomSdk({ role: 'attendee' }) });
    await send(serverMessage.action({ actionId: A1, tool: 'send_reaction', args: { reaction: 'thumbs_up' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(sdk.setEmojiReaction).toHaveBeenCalledTimes(1);
    expect(sdk.setEmojiReaction).toHaveBeenCalledWith({ emoji: '👍' });
    expect(results(fetchMock)[0].body).toEqual({ ok: true });
    await send(serverMessage.action({ actionId: A2, tool: 'send_reaction', args: { reaction: '💩' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(2));
    expect(results(fetchMock)[1].body).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.setEmojiReaction).toHaveBeenCalledTimes(1);
  });

  test('mute someone: the one person by that whole name is muted, never unmuted', async () => {
    const sdk = createZoomSdk({
      participants: [
        { screenName: 'Danny Lee', participantUUID: 'u-1', role: 'attendee' },
        { screenName: 'Danny Park', participantUUID: 'u-2', role: 'attendee' },
        { screenName: 'Ana', participantUUID: 'PARTICIPANT-UUID-1', role: 'host' },
      ],
    });
    const { fetchMock } = await openAsOwner({ sdk });
    await send(serverMessage.action({ actionId: A1, tool: 'mute_participant', args: { name: 'danny lee' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(sdk.toggleParticipantMediaAudio).toHaveBeenCalledTimes(1);
    expect(sdk.toggleParticipantMediaAudio).toHaveBeenCalledWith({ participantUUIDs: ['u-1'], audio: false });
    expect(results(fetchMock)[0].body).toEqual({ ok: true });
  });

  test('asked to mute the person whose panel this is: Zoom\'s call does not act on its caller, so nothing is tried', async () => {
    const sdk = createZoomSdk({
      participants: [{ screenName: 'Ana', participantUUID: 'PARTICIPANT-UUID-1', role: 'host' }],
    });
    const { fetchMock } = await openAsOwner({ sdk });
    await send(serverMessage.action({ actionId: A1, tool: 'mute_participant', args: { name: 'Ana' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(results(fetchMock)[0].body).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('an owner who is an attendee in Zoom is asked to mute someone: "not_allowed", the participants are not read', async () => {
    const sdk = createZoomSdk({ role: 'attendee', participants: [{ screenName: 'Danny Lee', participantUUID: 'u-1' }] });
    const { fetchMock } = await openAsOwner({ sdk });
    await send(serverMessage.action({ actionId: A1, tool: 'mute_participant', args: { name: 'Danny Lee' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(results(fetchMock)[0].body).toEqual({ ok: false, code: 'not_allowed' });
    expect(sdk.getMeetingParticipants).not.toHaveBeenCalled();
    expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('an owner who is an attendee in Zoom is asked to admit someone: "not_allowed"', async () => {
    const sdk = createZoomSdk({ role: 'attendee', waitingRoom: [{ screenName: 'James', participantUUID: 'W-1' }] });
    const { fetchMock } = await openAsOwner({ sdk });
    await send(serverMessage.action({ actionId: A1, tool: 'admit_from_waiting_room', args: { name: 'James' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(results(fetchMock)[0].body).toEqual({ ok: false, code: 'not_allowed' });
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
  });

  test('a participant\'s panel ignores an action entirely', async () => {
    const { sdk, fetchMock } = await open({ sdk: createZoomSdk({ role: 'attendee', screenName: 'Ben' }), state: ANA_BROUGHT_ARLO });
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    await send(serverMessage.action({ actionId: A1, ...CHAT }));
    await settle();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(results(fetchMock)).toHaveLength(0);
  });

  test('an action for another meeting is ignored', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessagesFor('OTHER-MEETING==').action({ actionId: A1, ...CHAT }));
    await settle();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(results(fetchMock)).toHaveLength(0);
  });

  test.each([
    ['no id', { ...CHAT }],
    ['an id that is not one', { actionId: '../../settings', ...CHAT }],
  ])('an action with %s is ignored', async (_name, action) => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.action(action));
    await settle();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(results(fetchMock)).toHaveLength(0);
  });

  test('after the meeting ended nothing is run', async () => {
    const { sdk, fetchMock } = await openAsOwner();
    await send(serverMessage.status('rtms_stopped', { meetingEnded: true }));
    await send(serverMessage.action({ actionId: A1, ...CHAT }));
    await settle();
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
    expect(results(fetchMock)).toHaveLength(0);
  });
});
