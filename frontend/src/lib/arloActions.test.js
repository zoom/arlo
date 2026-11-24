import { vi } from 'vitest';
import { runArloAction, handsFor } from './arloActions';

const sdkWith = (participants = []) => ({
  sendMessageToChat: vi.fn(async () => ({})),
  getWaitingRoomParticipants: vi.fn(async () => ({ participants })),
  admitParticipantFromWaitingRoom: vi.fn(async () => ({ message: 'Success' })),
});
const waiting = (screenName, participantUUID) => ({ screenName, participantUUID, role: 'attendee' });
const yes = () => true;
const admit = (sdk, name, zoomRole = 'host', stillAllowed = yes) => (
  runArloAction(sdk, { tool: 'admit_from_waiting_room', args: { name } }, { zoomRole, stillAllowed })
);

describe('handsFor: what a panel announces', () => {
  test('chat when the client has it; the waiting room only for a host or co-host whose client has it', () => {
    expect(handsFor({ chatSupported: true, waitingRoomSupported: true, zoomRole: 'host' })).toEqual(['post_to_chat', 'admit_from_waiting_room']);
    expect(handsFor({ chatSupported: true, waitingRoomSupported: true, zoomRole: 'coHost' })).toEqual(['post_to_chat', 'admit_from_waiting_room']);
    expect(handsFor({ chatSupported: true, waitingRoomSupported: true, zoomRole: 'attendee' })).toEqual(['post_to_chat']);
    expect(handsFor({ chatSupported: true, waitingRoomSupported: false, zoomRole: 'host' })).toEqual(['post_to_chat']);
    expect(handsFor({ chatSupported: false, waitingRoomSupported: false, zoomRole: 'host' })).toEqual([]);
  });
});

describe('post_to_chat', () => {
  test('sends the message to the meeting chat, once', async () => {
    const sdk = sdkWith();
    expect(await runArloAction(sdk, { tool: 'post_to_chat', args: { message: 'The beta moves to March 3.' } })).toEqual({ ok: true });
    expect(sdk.sendMessageToChat).toHaveBeenCalledTimes(1);
    expect(sdk.sendMessageToChat).toHaveBeenCalledWith({ message: 'The beta moves to March 3.' });
  });

  test('an SDK that rejects, or throws at once, is sdk_error', async () => {
    const rejects = sdkWith();
    rejects.sendMessageToChat = vi.fn(async () => { throw new Error('chat is off'); });
    expect(await runArloAction(rejects, { tool: 'post_to_chat', args: { message: 'hi' } })).toEqual({ ok: false, code: 'sdk_error' });
    const throws = sdkWith();
    throws.sendMessageToChat = vi.fn(() => { throw new Error('no'); });
    expect(await runArloAction(throws, { tool: 'post_to_chat', args: { message: 'hi' } })).toEqual({ ok: false, code: 'sdk_error' });
  });

  test.each([
    ['no message', {}],
    ['an empty message', { message: '   ' }],
    ['a message that is not text', { message: 7 }],
    ['a message over 510 characters', { message: 'x'.repeat(511) }],
    ['no arguments', undefined],
  ])('%s is not sent', async (_name, args) => {
    const sdk = sdkWith();
    expect(await runArloAction(sdk, { tool: 'post_to_chat', args })).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
  });

  test('"Arlo: " and an answer of 500 characters, 510 in all, is sent whole', async () => {
    const sdk = sdkWith();
    const message = `Arlo: ${'x'.repeat(504)}`;
    expect(message).toHaveLength(510);
    expect(await runArloAction(sdk, { tool: 'post_to_chat', args: { message } })).toEqual({ ok: true });
    expect(sdk.sendMessageToChat).toHaveBeenCalledWith({ message });
  });

  test('a client without the chat API: unsupported', async () => {
    expect(await runArloAction({}, { tool: 'post_to_chat', args: { message: 'hi' } })).toEqual({ ok: false, code: 'unsupported' });
    expect(await runArloAction(undefined, { tool: 'post_to_chat', args: { message: 'hi' } })).toEqual({ ok: false, code: 'unsupported' });
  });
});

describe('admit_from_waiting_room', () => {
  test('the full name, whatever the case: that person is admitted', async () => {
    const sdk = sdkWith([waiting('James Smith', 'u-1'), waiting('James Jones', 'u-2')]);
    expect(await admit(sdk, '  james   SMITH ')).toEqual({ ok: true });
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledTimes(1);
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'u-1' });
  });

  test('the same name written another way (composed or not, other spacing): still that person', async () => {
    const sdk = sdkWith([waiting('Jose\u0301  Nu\u0301n\u0303ez', 'u-1'), waiting('Bo Lee', 'u-2')]);
    expect(await admit(sdk, 'jos\u00e9 n\u00fa\u00f1ez', 'coHost')).toEqual({ ok: true });
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'u-1' });
  });

  test('a first name alone admits nobody, even when only one person has it: several_match', async () => {
    const sdk = sdkWith([waiting('Sam Stranger', 'u-1'), waiting('Bo Lee', 'u-2')]);
    expect(await admit(sdk, 'Sam')).toEqual({ ok: false, code: 'several_match' });
    expect(await admit(sdk, 'Sam', 'coHost')).toEqual({ ok: false, code: 'several_match' });
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
  });

  test('part of a name that is not its first word is nobody: not_found', async () => {
    const sdk = sdkWith([waiting('Sam Stranger', 'u-1')]);
    expect(await admit(sdk, 'Stranger')).toEqual({ ok: false, code: 'not_found' });
    expect(await admit(sdk, 'Sa')).toEqual({ ok: false, code: 'not_found' });
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
  });

  test('someone whose whole name it is, beside someone it is the first name of: the one whose name it is', async () => {
    const sdk = sdkWith([waiting('James', 'u-1'), waiting('James Jones', 'u-2')]);
    expect(await admit(sdk, 'James')).toEqual({ ok: true });
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledTimes(1);
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'u-1' });
  });

  test('the panel may no longer act once the list is back: not_allowed, nobody admitted', async () => {
    const sdk = sdkWith([waiting('James', 'u-1')]);
    let allowed = true;
    sdk.getWaitingRoomParticipants = vi.fn(async () => { allowed = false; return { participants: [waiting('James', 'u-1')] }; });
    expect(await admit(sdk, 'James', 'host', () => allowed)).toEqual({ ok: false, code: 'not_allowed' });
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    // Nothing to ask whether it still may: nobody is admitted
    const unasked = sdkWith([waiting('James', 'u-1')]);
    expect(await runArloAction(unasked, { tool: 'admit_from_waiting_room', args: { name: 'James' } }, { zoomRole: 'host' }))
      .toEqual({ ok: false, code: 'not_allowed' });
    expect(await admit(unasked, 'James', 'host', () => 'yes')).toEqual({ ok: false, code: 'not_allowed' });
    expect(unasked.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
  });

  test('nobody by that name: not_found, nobody admitted', async () => {
    const sdk = sdkWith([waiting('Bo Lee', 'u-2')]);
    expect(await admit(sdk, 'James')).toEqual({ ok: false, code: 'not_found' });
    expect(await admit(sdkWith([]), 'James')).toEqual({ ok: false, code: 'not_found' });
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
  });

  test('several people by that name: several_match, nobody admitted', async () => {
    const first = sdkWith([waiting('James Smith', 'u-1'), waiting('James Jones', 'u-2')]);
    expect(await admit(first, 'James')).toEqual({ ok: false, code: 'several_match' });
    expect(first.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    const full = sdkWith([waiting('James Smith', 'u-1'), waiting('james smith', 'u-2')]);
    expect(await admit(full, 'James Smith')).toEqual({ ok: false, code: 'several_match' });
    expect(full.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
  });

  test('someone who is not the host or a co-host: not_allowed, the waiting room is not read', async () => {
    const sdk = sdkWith([waiting('James', 'u-1')]);
    expect(await admit(sdk, 'James', 'attendee')).toEqual({ ok: false, code: 'not_allowed' });
    expect(await runArloAction(sdk, { tool: 'admit_from_waiting_room', args: { name: 'James' } })).toEqual({ ok: false, code: 'not_allowed' });
    expect(sdk.getWaitingRoomParticipants).not.toHaveBeenCalled();
  });

  test('a client without the waiting-room APIs: unsupported', async () => {
    expect(await admit({ sendMessageToChat: vi.fn() }, 'James')).toEqual({ ok: false, code: 'unsupported' });
  });

  test('no usable name: unsupported', async () => {
    const sdk = sdkWith([waiting('James', 'u-1')]);
    expect(await admit(sdk, '  ')).toEqual({ ok: false, code: 'unsupported' });
    expect(await admit(sdk, 'x'.repeat(101))).toEqual({ ok: false, code: 'unsupported' });
    expect(await admit(sdk, 5)).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.getWaitingRoomParticipants).not.toHaveBeenCalled();
  });

  test('listing or admitting fails, or Zoom answers with no list: sdk_error', async () => {
    const noList = sdkWith();
    noList.getWaitingRoomParticipants = vi.fn(async () => { throw new Error('10240'); });
    expect(await admit(noList, 'James')).toEqual({ ok: false, code: 'sdk_error' });
    const odd = sdkWith();
    odd.getWaitingRoomParticipants = vi.fn(async () => ({}));
    expect(await admit(odd, 'James')).toEqual({ ok: false, code: 'sdk_error' });
    const noAdmit = sdkWith([waiting('James', 'u-1')]);
    noAdmit.admitParticipantFromWaitingRoom = vi.fn(async () => { throw new Error('10238'); });
    expect(await admit(noAdmit, 'James')).toEqual({ ok: false, code: 'sdk_error' });
    const noId = sdkWith([waiting('James', undefined)]);
    expect(await admit(noId, 'James')).toEqual({ ok: false, code: 'sdk_error' });
  });
});

test('a tool the panel does not have: unsupported, and nothing is called', async () => {
  const sdk = sdkWith();
  expect(await runArloAction(sdk, { tool: 'open_breakout_rooms', args: {} })).toEqual({ ok: false, code: 'unsupported' });
  expect(await runArloAction(sdk, { tool: 'constructor', args: {} })).toEqual({ ok: false, code: 'unsupported' });
  expect(await runArloAction(sdk, null)).toEqual({ ok: false, code: 'unsupported' });
  expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
});
