import { vi } from 'vitest';
import { runArloAction, handsFor } from './arloActions';

const sdkWith = (participants = []) => ({
  sendMessageToChat: vi.fn(async () => ({})),
  getWaitingRoomParticipants: vi.fn(async () => ({ participants })),
  admitParticipantFromWaitingRoom: vi.fn(async () => ({ message: 'Success' })),
});
const waiting = (screenName, participantUUID) => ({ screenName, participantUUID, role: 'attendee' });
const admit = (sdk, name, zoomRole = 'host') => runArloAction(sdk, { tool: 'admit_from_waiting_room', args: { name } }, { zoomRole });

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
    ['a message over 300 characters', { message: 'x'.repeat(301) }],
    ['no arguments', undefined],
  ])('%s is not sent', async (_name, args) => {
    const sdk = sdkWith();
    expect(await runArloAction(sdk, { tool: 'post_to_chat', args })).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
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

  test('a first name only one person has: admitted', async () => {
    const sdk = sdkWith([waiting('James Smith', 'u-1'), waiting('Bo Lee', 'u-2')]);
    expect(await admit(sdk, 'James', 'coHost')).toEqual({ ok: true });
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'u-1' });
  });

  test('a full name wins over the same first name of someone else', async () => {
    const sdk = sdkWith([waiting('James', 'u-1'), waiting('James Jones', 'u-2')]);
    expect(await admit(sdk, 'James')).toEqual({ ok: true });
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'u-1' });
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
