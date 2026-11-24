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
  vi.restoreAllMocks();
  resetHarness();
});

describe('what the panel says it can do', () => {
  test('an owner who is the host: the chat and the waiting room, after the subscription', async () => {
    await openAsOwner();
    await waitFor(() => expect(hands()).toHaveLength(1));
    expect(hands()[0]).toEqual({ type: 'arlo.hands', payload: { zoomRole: 'host', can: ['post_to_chat', 'admit_from_waiting_room'] } });
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
    ['a co-host announces the waiting room too', 'coHost', ['post_to_chat', 'admit_from_waiting_room']],
    ['an attendee who owns a stream announces only the chat', 'attendee', ['post_to_chat']],
  ])('%s', async (_name, role, can) => {
    await openAsOwner({ sdk: createZoomSdk({ role }) });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: role, can }));
  });

  test('a host whose Zoom client has no waiting-room APIs does not announce that tool', async () => {
    const sdk = createZoomSdk({ waitingRoomApis: false });
    await openAsOwner({ sdk });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'host', can: ['post_to_chat'] }));
    // The rest of what the client accepts is kept: Zoom's indicator APIs are still asked for
    expect(sdk.config.mock.calls.at(-1)[0].capabilities).toContain('setDynamicIndicator');
    expect(sdk.config.mock.calls.at(-1)[0].capabilities).not.toContain('getWaitingRoomParticipants');
  });

  test('the Zoom role changes: the announcement follows', async () => {
    const { sdk } = await openAsOwner({ sdk: createZoomSdk({ role: 'attendee' }) });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'attendee', can: ['post_to_chat'] }));
    await act(async () => { sdk.emit('onMyUserContextChange', { role: 'coHost' }); });
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'coHost', can: ['post_to_chat', 'admit_from_waiting_room'] }));
    expect(hands()).toHaveLength(2);
  });

  test('a participant announces nothing; one who becomes an owner does; one who stops being one clears it', async () => {
    await open({ sdk: createZoomSdk({ role: 'attendee', screenName: 'Ben' }), state: ANA_BROUGHT_ARLO });
    await screen.findByRole('heading', { name: 'Ana brought Arlo into this meeting' });
    await settle();
    expect(hands()).toHaveLength(0);

    await send(serverMessage.arloState(OWNER));
    await waitFor(() => expect(lastHands()).toEqual({ zoomRole: 'attendee', can: ['post_to_chat'] }));

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
    expect(lastHands()).toEqual({ zoomRole: 'host', can: ['post_to_chat', 'admit_from_waiting_room'] });
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

  test('admit from the waiting room: the one person by that name is admitted', async () => {
    const sdk = createZoomSdk({ waitingRoom: [{ screenName: 'James Smith', participantUUID: 'W-1' }, { screenName: 'Bo', participantUUID: 'W-2' }] });
    const { fetchMock } = await openAsOwner({ sdk });
    await send(serverMessage.action({ actionId: A1, tool: 'admit_from_waiting_room', args: { name: 'james' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(1));
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledTimes(1);
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'W-1' });
    expect(results(fetchMock)[0].body).toEqual({ ok: true });

    await send(serverMessage.action({ actionId: A2, tool: 'admit_from_waiting_room', args: { name: 'Noor' } }));
    await waitFor(() => expect(results(fetchMock)).toHaveLength(2));
    expect(results(fetchMock)[1].body).toEqual({ ok: false, code: 'not_found' });
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledTimes(1);
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
