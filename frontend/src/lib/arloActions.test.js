import { vi } from 'vitest';
import { runArloAction, handsFor, REACTIONS } from './arloActions';

const sdkWith = (participants = []) => ({
  sendMessageToChat: vi.fn(async () => ({})),
  getWaitingRoomParticipants: vi.fn(async () => ({ participants })),
  admitParticipantFromWaitingRoom: vi.fn(async () => ({ message: 'Success' })),
});
const waiting = (screenName, participantUUID) => ({ screenName, participantUUID, role: 'attendee' });
const yes = () => true;
const meetingSdk = (participants = []) => ({
  sendAppInvitationToAllParticipants: vi.fn(async () => ({ invitationUUID: 'i-1' })),
  setEmojiReaction: vi.fn(async () => ({ message: 'Success' })),
  getMeetingParticipants: vi.fn(async () => ({ participants })),
  toggleParticipantMediaAudio: vi.fn(async () => ({ message: 'Success' })),
});
const person = (screenName, participantUUID, role = 'attendee') => ({ screenName, participantUUID, participantId: '1', role });
const mute = (sdk, name, zoomRole = 'host', stillAllowed = yes, extra = {}) => (
  runArloAction(sdk, { tool: 'mute_participant', args: { name } }, { zoomRole, stillAllowed, ...extra })
);
const react = (sdk, reaction) => runArloAction(sdk, { tool: 'send_reaction', args: { reaction } });
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

  test('inviting and reacting for anyone whose client has them; muting only for a host or co-host', () => {
    const all = {
      chatSupported: true, waitingRoomSupported: true, invitationSupported: true, reactionSupported: true, muteSupported: true,
    };
    expect(handsFor({ ...all, zoomRole: 'host' }))
      .toEqual(['post_to_chat', 'admit_from_waiting_room', 'invite_everyone', 'send_reaction', 'mute_participant']);
    expect(handsFor({ ...all, zoomRole: 'coHost' }))
      .toEqual(['post_to_chat', 'admit_from_waiting_room', 'invite_everyone', 'send_reaction', 'mute_participant']);
    expect(handsFor({ ...all, zoomRole: 'attendee' })).toEqual(['post_to_chat', 'invite_everyone', 'send_reaction']);
    expect(handsFor({ ...all, muteSupported: false, zoomRole: 'host' }))
      .toEqual(['post_to_chat', 'admit_from_waiting_room', 'invite_everyone', 'send_reaction']);
    expect(handsFor({ ...all, invitationSupported: false, zoomRole: 'attendee' })).toEqual(['post_to_chat', 'send_reaction']);
    expect(handsFor({ ...all, reactionSupported: false, zoomRole: 'attendee' })).toEqual(['post_to_chat', 'invite_everyone']);
    expect(handsFor({ invitationSupported: true, zoomRole: 'attendee' })).toEqual(['invite_everyone']);
    expect(handsFor({ reactionSupported: true, zoomRole: null })).toEqual(['send_reaction']);
    expect(handsFor({ muteSupported: true, zoomRole: 'host' })).toEqual(['mute_participant']);
    // Only exactly `true` counts
    expect(handsFor({ invitationSupported: 'yes', reactionSupported: 1, muteSupported: {}, zoomRole: 'host' })).toEqual([]);
  });

  test('never more names than the server takes', () => {
    const all = {
      chatSupported: true, waitingRoomSupported: true, invitationSupported: true, reactionSupported: true, muteSupported: true,
    };
    expect(handsFor({ ...all, zoomRole: 'host' }).length).toBeLessThanOrEqual(10);
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

  test('someone whose whole name it is, beside someone whose name starts with it: several_match, nobody admitted', async () => {
    const sdk = sdkWith([waiting('James', 'u-1'), waiting('James Jones', 'u-2')]);
    expect(await admit(sdk, 'James')).toEqual({ ok: false, code: 'several_match' });
    const twoWords = sdkWith([waiting('James Lee Jones', 'u-2'), waiting('James Lee', 'u-1')]);
    expect(await admit(twoWords, 'James Lee')).toEqual({ ok: false, code: 'several_match' });
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    expect(twoWords.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    // a name that only begins with the same letters is another name
    const other = sdkWith([waiting('James', 'u-1'), waiting('Jameson Jones', 'u-2')]);
    expect(await admit(other, 'James')).toEqual({ ok: true });
    expect(other.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'u-1' });
  });

  test('a name that differs only by characters nobody sees is the same name: several_match', async () => {
    for (const hidden of ['\u200B', '\u200C', '\u200D', '\u00AD', '\u200E', '\u202E', '\u2060', '\uFEFF']) {
      const sdk = sdkWith([waiting('James Smith', 'u-1'), waiting(`James Smith${hidden}`, 'u-2')]);
      expect(await admit(sdk, 'James Smith')).toEqual({ ok: false, code: 'several_match' });
      const inside = sdkWith([waiting('James Smith', 'u-1'), waiting(`Ja${hidden}mes Smith`, 'u-2')]);
      expect(await admit(inside, 'James Smith')).toEqual({ ok: false, code: 'several_match' });
      expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
      expect(inside.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    }
    // written in compatibility forms (full width, a ligature, a no-break space): the same name too
    const wide = sdkWith([waiting('James Smith', 'u-1'), waiting('\uFF2A\uFF41\uFF4D\uFF45\uFF53\u00A0Smith', 'u-2')]);
    expect(await admit(wide, 'James Smith')).toEqual({ ok: false, code: 'several_match' });
    // and alone, such a name is that person's
    const alone = sdkWith([waiting('James\u200B Smith', 'u-1')]);
    expect(await admit(alone, 'James Smith')).toEqual({ ok: true });
  });

  test('a name that mixes Latin letters with Cyrillic or Greek ones in a word is nobody\'s: several_match', async () => {
    // "Jаmes" with a Cyrillic а, "Jοhn" with a Greek omicron
    const cyrillic = 'J\u0430mes Smith';
    const sdk = sdkWith([waiting('James Smith', 'u-1'), waiting(cyrillic, 'u-2'), waiting('J\u03BFhn', 'u-3')]);
    expect(await admit(sdk, cyrillic)).toEqual({ ok: false, code: 'several_match' });
    expect(await admit(sdk, 'J\u03BFhn')).toEqual({ ok: false, code: 'several_match' });
    expect(await admit(sdkWith([]), cyrillic)).toEqual({ ok: false, code: 'several_match' });
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
    // the real one is still found
    expect(await admit(sdk, 'James Smith')).toEqual({ ok: true });
    expect(sdk.admitParticipantFromWaitingRoom).toHaveBeenCalledWith({ participantUUID: 'u-1' });
    // names wholly in one script, and one script per word, work as before
    const names = ['\u0418\u0432\u0430\u043D \u041F\u0435\u0442\u0440\u043E\u0432', '\u039D\u03AF\u03BA\u03BF\u03C2', 'Anna \u0418\u0432\u0430\u043D\u043E\u0432\u0430', '\u7530\u4E2D Ken'];
    for (const name of names) {
      const one = sdkWith([waiting(name, 'u-9'), waiting('Bo Lee', 'u-2')]);
      expect(await admit(one, name)).toEqual({ ok: true });
    }
  });

  test('more people waiting than are looked through: sdk_error, nobody admitted', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => waiting(`Guest ${i}`, `g-${i}`));
    const sdk = sdkWith([waiting('James Smith', 'u-1'), ...many]);
    expect(await admit(sdk, 'James Smith')).toEqual({ ok: false, code: 'sdk_error' });
    expect(sdk.admitParticipantFromWaitingRoom).not.toHaveBeenCalled();
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

describe('invite_everyone', () => {
  test('sends the app invitation to everyone, once, with no arguments', async () => {
    const sdk = meetingSdk();
    expect(await runArloAction(sdk, { tool: 'invite_everyone', args: {} })).toEqual({ ok: true });
    expect(sdk.sendAppInvitationToAllParticipants).toHaveBeenCalledTimes(1);
    expect(sdk.sendAppInvitationToAllParticipants).toHaveBeenCalledWith();
  });

  test('any Zoom role may: an attendee too', async () => {
    const sdk = meetingSdk();
    expect(await runArloAction(sdk, { tool: 'invite_everyone', args: {} }, { zoomRole: 'attendee' })).toEqual({ ok: true });
    expect(await runArloAction(sdk, { tool: 'invite_everyone' })).toEqual({ ok: true });
  });

  test('a client without the API: unsupported', async () => {
    expect(await runArloAction({}, { tool: 'invite_everyone', args: {} })).toEqual({ ok: false, code: 'unsupported' });
    expect(await runArloAction(undefined, { tool: 'invite_everyone', args: {} })).toEqual({ ok: false, code: 'unsupported' });
  });

  test.each([
    ['an argument', { name: 'James' }],
    ['arguments that are a list', []],
    ['arguments that are text', 'everyone'],
  ])('%s is not what was approved: unsupported, nobody invited', async (_name, args) => {
    const sdk = meetingSdk();
    expect(await runArloAction(sdk, { tool: 'invite_everyone', args })).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.sendAppInvitationToAllParticipants).not.toHaveBeenCalled();
  });

  test('an SDK that rejects, or throws at once, is sdk_error', async () => {
    const rejects = meetingSdk();
    rejects.sendAppInvitationToAllParticipants = vi.fn(async () => { throw new Error('chat is off'); });
    expect(await runArloAction(rejects, { tool: 'invite_everyone', args: {} })).toEqual({ ok: false, code: 'sdk_error' });
    const throws = meetingSdk();
    throws.sendAppInvitationToAllParticipants = vi.fn(() => { throw new Error('no'); });
    expect(await runArloAction(throws, { tool: 'invite_everyone', args: {} })).toEqual({ ok: false, code: 'sdk_error' });
  });
});

describe('send_reaction', () => {
  // The same table is on the server (backend/src/services/agent/texts.js,
  // REACTIONS), which shows the emoji on the sheet; this one is what Zoom is
  // sent. backend/test/agent-steps.test.js holds the server's to the same
  // literal: change one and a test fails until both are changed.
  test('the table is fixed: six reactions, these emoji, and it cannot be changed', () => {
    expect(Object.entries(REACTIONS)).toEqual([
      ['thumbs_up', '\u{1F44D}'],
      ['clap', '\u{1F44F}'],
      // the heart with its variation selector: U+2764 U+FE0F
      ['heart', '\u2764\uFE0F'],
      ['joy', '\u{1F602}'],
      ['tada', '\u{1F389}'],
      ['open_mouth', '\u{1F62E}'],
    ]);
    expect(Object.isFrozen(REACTIONS)).toBe(true);
  });

  test.each([
    ['thumbs_up', '\u{1F44D}'],
    ['clap', '\u{1F44F}'],
    ['heart', '\u2764\uFE0F'],
    ['joy', '\u{1F602}'],
    ['tada', '\u{1F389}'],
    ['open_mouth', '\u{1F62E}'],
  ])('%s sends its emoji, once, and nothing else', async (reaction, emoji) => {
    const sdk = meetingSdk();
    expect(await react(sdk, reaction)).toEqual({ ok: true });
    expect(sdk.setEmojiReaction).toHaveBeenCalledTimes(1);
    expect(sdk.setEmojiReaction).toHaveBeenCalledWith({ emoji });
  });

  test.each([
    ['a reaction that is not in the table', 'fire'],
    ['an emoji instead of its name', '\u{1F44D}'],
    ['another case', 'Thumbs_Up'],
    ['a name every object has', 'constructor'],
    ['another', '__proto__'],
    ['a number', 1],
    ['a list', ['clap']],
    ['nothing', undefined],
    ['an empty text', ''],
  ])('%s: unsupported, no reaction sent', async (_name, reaction) => {
    const sdk = meetingSdk();
    expect(await react(sdk, reaction)).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.setEmojiReaction).not.toHaveBeenCalled();
  });

  test('no arguments: unsupported', async () => {
    const sdk = meetingSdk();
    expect(await runArloAction(sdk, { tool: 'send_reaction' })).toEqual({ ok: false, code: 'unsupported' });
    expect(await runArloAction(sdk, { tool: 'send_reaction', args: null })).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.setEmojiReaction).not.toHaveBeenCalled();
  });

  test('a client without the API: unsupported', async () => {
    expect(await react({}, 'clap')).toEqual({ ok: false, code: 'unsupported' });
  });

  test('Zoom refuses (reactions are off in this meeting), or throws at once: sdk_error', async () => {
    const rejects = meetingSdk();
    rejects.setEmojiReaction = vi.fn(async () => { throw new Error('10153'); });
    expect(await react(rejects, 'clap')).toEqual({ ok: false, code: 'sdk_error' });
    const throws = meetingSdk();
    throws.setEmojiReaction = vi.fn(() => { throw new Error('no'); });
    expect(await react(throws, 'clap')).toEqual({ ok: false, code: 'sdk_error' });
  });
});

describe('mute_participant', () => {
  test('the full name, whatever the case: that one person is muted', async () => {
    const sdk = meetingSdk([person('Danny Lee', 'u-1'), person('Danny Park', 'u-2'), person('Ana', 'u-me', 'host')]);
    expect(await mute(sdk, '  danny   LEE ')).toEqual({ ok: true });
    expect(sdk.toggleParticipantMediaAudio).toHaveBeenCalledTimes(1);
    expect(sdk.toggleParticipantMediaAudio).toHaveBeenCalledWith({ participantUUIDs: ['u-1'], audio: false });
  });

  test('a co-host may too; the same name written another way is still that person', async () => {
    const sdk = meetingSdk([person('Jose\u0301  Nu\u0301n\u0303ez', 'u-1'), person('Bo Lee', 'u-2')]);
    expect(await mute(sdk, 'jos\u00e9 n\u00fa\u00f1ez', 'coHost')).toEqual({ ok: true });
    expect(sdk.toggleParticipantMediaAudio).toHaveBeenCalledWith({ participantUUIDs: ['u-1'], audio: false });
  });

  test('whatever is asked, the call is only ever "mute" for exactly one person', async () => {
    const people = [person('Danny Lee', 'u-1'), person('Danny Park', 'u-2'), person('Bo', 'u-3'), person('Bo', 'u-4'), person('Cy', '')];
    const sdk = meetingSdk(people);
    const asks = [
      { name: 'Danny Lee' }, { name: 'Danny' }, { name: 'Bo' }, { name: 'Cy' }, { name: 'Nobody' }, { name: '' },
      { name: 'Danny Lee', audio: true }, { name: 'Danny Park', unmute: true, participantUUIDs: [] },
      { name: 'Danny Lee', participantUUIDs: ['u-2', 'u-3'] }, {}, null,
    ];
    for (const args of asks) {
      await runArloAction(sdk, { tool: 'mute_participant', args }, { zoomRole: 'host', stillAllowed: yes });
    }
    expect(sdk.toggleParticipantMediaAudio.mock.calls.length).toBeGreaterThan(0);
    sdk.toggleParticipantMediaAudio.mock.calls.forEach((call) => {
      expect(call).toHaveLength(1);
      expect(Object.keys(call[0]).sort()).toEqual(['audio', 'participantUUIDs']);
      expect(call[0].audio).toBe(false);
      expect(call[0].participantUUIDs).toHaveLength(1);
      expect(['u-1', 'u-2']).toContain(call[0].participantUUIDs[0]);
    });
  });

  test('arguments besides the name are not what was approved: unsupported, the list is not read', async () => {
    const sdk = meetingSdk([person('Danny Lee', 'u-1')]);
    expect(await runArloAction(sdk, { tool: 'mute_participant', args: { name: 'Danny Lee', audio: true } }, { zoomRole: 'host', stillAllowed: yes }))
      .toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.getMeetingParticipants).not.toHaveBeenCalled();
    expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('someone who is not the host or a co-host: not_allowed, the participants are not read', async () => {
    const sdk = meetingSdk([person('Danny Lee', 'u-1')]);
    expect(await mute(sdk, 'Danny Lee', 'attendee')).toEqual({ ok: false, code: 'not_allowed' });
    expect(await runArloAction(sdk, { tool: 'mute_participant', args: { name: 'Danny Lee' } })).toEqual({ ok: false, code: 'not_allowed' });
    expect(sdk.getMeetingParticipants).not.toHaveBeenCalled();
    expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('nobody by that name: not_found, nobody muted', async () => {
    const sdk = meetingSdk([person('Bo Lee', 'u-2')]);
    expect(await mute(sdk, 'Danny Lee')).toEqual({ ok: false, code: 'not_found' });
    expect(await mute(sdk, 'Lee')).toEqual({ ok: false, code: 'not_found' });
    expect(await mute(meetingSdk([]), 'Danny Lee')).toEqual({ ok: false, code: 'not_found' });
    expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('two people with the name: several_match, nobody muted', async () => {
    const sdk = meetingSdk([person('Danny Lee', 'u-1'), person('danny  lee', 'u-2')]);
    expect(await mute(sdk, 'Danny Lee')).toEqual({ ok: false, code: 'several_match' });
    expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('a first name alone mutes nobody, even when only one person has it: several_match', async () => {
    const sdk = meetingSdk([person('Danny Lee', 'u-1'), person('Bo Lee', 'u-2')]);
    expect(await mute(sdk, 'Danny')).toEqual({ ok: false, code: 'several_match' });
    expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('someone whose whole name it is, beside someone whose name only starts with the same letters: the one whose name it is', async () => {
    const sdk = meetingSdk([person('Danny', 'u-1'), person('Dannyboy Lee', 'u-2'), person('Lee Danny', 'u-3')]);
    expect(await mute(sdk, 'Danny')).toEqual({ ok: true });
    expect(sdk.toggleParticipantMediaAudio).toHaveBeenCalledWith({ participantUUIDs: ['u-1'], audio: false });
  });

  test('the panel may no longer act once the list is back: not_allowed, nobody muted', async () => {
    const sdk = meetingSdk();
    let allowed = true;
    sdk.getMeetingParticipants = vi.fn(async () => { allowed = false; return { participants: [person('Danny Lee', 'u-1')] }; });
    expect(await mute(sdk, 'Danny Lee', 'host', () => allowed)).toEqual({ ok: false, code: 'not_allowed' });
    expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
    // Nothing to ask whether it still may: nobody is muted
    const unasked = meetingSdk([person('Danny Lee', 'u-1')]);
    expect(await runArloAction(unasked, { tool: 'mute_participant', args: { name: 'Danny Lee' } }, { zoomRole: 'host' }))
      .toEqual({ ok: false, code: 'not_allowed' });
    expect(await mute(unasked, 'Danny Lee', 'host', () => 'yes')).toEqual({ ok: false, code: 'not_allowed' });
    expect(unasked.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('a participant without a UUID: sdk_error, and never a call without one (an empty list would mute everyone)', async () => {
    for (const uuid of [undefined, '', null, 7]) {
      const sdk = meetingSdk([person('Danny Lee', uuid)]);
      expect(await mute(sdk, 'Danny Lee')).toEqual({ ok: false, code: 'sdk_error' });
      expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
    }
  });

  test('listing or muting fails, or Zoom answers with no list: sdk_error', async () => {
    const noList = meetingSdk();
    noList.getMeetingParticipants = vi.fn(async () => { throw new Error('not the host'); });
    expect(await mute(noList, 'Danny Lee')).toEqual({ ok: false, code: 'sdk_error' });
    const odd = meetingSdk();
    odd.getMeetingParticipants = vi.fn(async () => ({}));
    expect(await mute(odd, 'Danny Lee')).toEqual({ ok: false, code: 'sdk_error' });
    const noMute = meetingSdk([person('Danny Lee', 'u-1')]);
    noMute.toggleParticipantMediaAudio = vi.fn(async () => { throw new Error('10109'); });
    expect(await mute(noMute, 'Danny Lee')).toEqual({ ok: false, code: 'sdk_error' });
    const throws = meetingSdk([person('Danny Lee', 'u-1')]);
    throws.toggleParticipantMediaAudio = vi.fn(() => { throw new Error('no'); });
    expect(await mute(throws, 'Danny Lee')).toEqual({ ok: false, code: 'sdk_error' });
  });

  test('a client without either API: unsupported', async () => {
    const noToggle = meetingSdk([person('Danny Lee', 'u-1')]);
    delete noToggle.toggleParticipantMediaAudio;
    expect(await mute(noToggle, 'Danny Lee')).toEqual({ ok: false, code: 'unsupported' });
    expect(noToggle.getMeetingParticipants).not.toHaveBeenCalled();
    const noList = meetingSdk();
    delete noList.getMeetingParticipants;
    expect(await mute(noList, 'Danny Lee')).toEqual({ ok: false, code: 'unsupported' });
    expect(noList.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('no usable name: unsupported', async () => {
    const sdk = meetingSdk([person('Danny Lee', 'u-1')]);
    expect(await mute(sdk, '  ')).toEqual({ ok: false, code: 'unsupported' });
    expect(await mute(sdk, 'x'.repeat(101))).toEqual({ ok: false, code: 'unsupported' });
    expect(await mute(sdk, 5)).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.getMeetingParticipants).not.toHaveBeenCalled();
  });

  test('a name of 100 characters is looked for', async () => {
    const name = 'x'.repeat(100);
    const sdk = meetingSdk([person(name, 'u-1')]);
    expect(await mute(sdk, name)).toEqual({ ok: true });
  });

  test('a meeting of more than 1000 people is not looked through at all: sdk_error, whoever is asked for', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => person(`Guest ${i}`, `g-${i}`));
    for (const list of [[...many, person('Danny Lee', 'u-1')], [person('Danny Lee', 'u-1'), ...many]]) {
      const sdk = meetingSdk(list);
      expect(await mute(sdk, 'Danny Lee')).toEqual({ ok: false, code: 'sdk_error' });
      expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
    }
    // exactly 1000 are looked through
    const full = meetingSdk([...many.slice(1), person('Danny Lee', 'u-1')]);
    expect(await mute(full, 'Danny Lee')).toEqual({ ok: true });
  });

  test('"Danny" beside "Danny Lee", or beside a "Danny" nobody can tell apart: several_match, nobody muted', async () => {
    const lists = [
      [person('Danny', 'u-1'), person('Danny Lee', 'u-2')],
      [person('Danny', 'u-1'), person('Danny\u200B', 'u-2')],
      [person('Danny', 'u-1'), person('D\u0430nny', 'u-2'), person('danny  park', 'u-3')],
    ];
    for (const list of lists) {
      const sdk = meetingSdk(list);
      expect(await mute(sdk, 'Danny')).toEqual({ ok: false, code: 'several_match' });
      expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
    }
    const lookalike = meetingSdk([person('Danny', 'u-1'), person('D\u0430nny', 'u-2')]);
    expect(await mute(lookalike, 'D\u0430nny')).toEqual({ ok: false, code: 'several_match' });
    expect(lookalike.toggleParticipantMediaAudio).not.toHaveBeenCalled();
  });

  test('the person asking is the one named: Zoom does not mute the caller this way, so unsupported and no call', async () => {
    const sdk = meetingSdk([person('Ana', 'u-me', 'host'), person('Danny Lee', 'u-1')]);
    expect(await mute(sdk, 'Ana', 'host', yes, { selfParticipantUUID: 'u-me' })).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.toggleParticipantMediaAudio).not.toHaveBeenCalled();
    // Someone else is muted as usual, and without knowing who the caller is Zoom decides
    expect(await mute(sdk, 'Danny Lee', 'host', yes, { selfParticipantUUID: 'u-me' })).toEqual({ ok: true });
    expect(await mute(sdk, 'Ana')).toEqual({ ok: true });
    expect(sdk.toggleParticipantMediaAudio).toHaveBeenLastCalledWith({ participantUUIDs: ['u-me'], audio: false });
  });
});

describe('open_ticket', () => {
  const BASE = 'https://jira.example.test';
  const URL_123 = `${BASE}/browse/PROJ-123`;
  const browserSdk = () => ({
    openUrl: vi.fn(async () => ({ message: 'Success' })),
    promptShareScreen: vi.fn(async () => ({ message: 'Success' })),
  });
  const openTicket = (sdk, args, extra = {}) => (
    runArloAction(sdk, { tool: 'open_ticket', args }, { stillAllowed: yes, jiraBaseUrl: BASE, ...extra })
  );
  const ticket = (extra = {}) => ({ url: URL_123, key: 'PROJ-123', share: false, ...extra });

  test('opens the ticket in the browser, and nothing else when no share was asked for', async () => {
    const sdk = browserSdk();
    expect(await openTicket(sdk, ticket())).toEqual({ ok: true });
    expect(sdk.openUrl).toHaveBeenCalledTimes(1);
    expect(sdk.openUrl).toHaveBeenCalledWith({ url: URL_123 });
    expect(sdk.promptShareScreen).not.toHaveBeenCalled();
  });

  test('with share: the ticket first, then Zoom\'s share dialog, with no options', async () => {
    const sdk = browserSdk();
    const order = [];
    sdk.openUrl.mockImplementation(async () => { order.push('open'); });
    sdk.promptShareScreen.mockImplementation(async (...given) => { order.push(['share', given]); });
    expect(await openTicket(sdk, ticket({ share: true }))).toEqual({ ok: true });
    expect(order).toEqual(['open', ['share', []]]);
    expect(sdk.openUrl).toHaveBeenCalledWith({ url: URL_123 });
  });

  test('a base URL with a context path: the URL is that base, "/browse/", the key', async () => {
    const sdk = browserSdk();
    const base = 'https://tools.example.test/jira';
    expect(await openTicket(sdk, { url: `${base}/browse/AB-1`, key: 'AB-1', share: false }, { jiraBaseUrl: base })).toEqual({ ok: true });
    expect(sdk.openUrl).toHaveBeenCalledWith({ url: `${base}/browse/AB-1` });
    // and not the same path on the host alone
    expect(await openTicket(sdk, { url: 'https://tools.example.test/browse/AB-1', key: 'AB-1', share: false }, { jiraBaseUrl: base }))
      .toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.openUrl).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['another host', 'https://evil.example/browse/PROJ-123'],
    ['a host that only starts like it', 'https://jira.example.test.evil.example/browse/PROJ-123'],
    ['http', 'http://jira.example.test/browse/PROJ-123'],
    ['another scheme', 'javascript:alert(1)//jira.example.test/browse/PROJ-123'],
    ['an extra path', 'https://jira.example.test/browse/PROJ-123/../../secure/admin'],
    ['a path before it', 'https://jira.example.test/x/browse/PROJ-123'],
    ['another path', 'https://jira.example.test/secure/PROJ-123'],
    ['a trailing slash', 'https://jira.example.test/browse/PROJ-123/'],
    ['a query', 'https://jira.example.test/browse/PROJ-123?next=https://evil.example'],
    ['a fragment', 'https://jira.example.test/browse/PROJ-123#x'],
    ['another key than the one named', 'https://jira.example.test/browse/PROJ-124'],
    ['the key in lower case', 'https://jira.example.test/browse/proj-123'],
    ['credentials', 'https://user:secret@jira.example.test/browse/PROJ-123'],
    ['a user name', 'https://jira.example.test@evil.example/browse/PROJ-123'],
    ['a port', 'https://jira.example.test:8443/browse/PROJ-123'],
    ['the host in upper case', 'https://JIRA.example.test/browse/PROJ-123'],
    ['a space around it', ' https://jira.example.test/browse/PROJ-123'],
    ['a line break in it', 'https://jira.example.test/browse/PROJ-123\n'],
    ['backslashes', 'https:\\\\jira.example.test\\browse\\PROJ-123'],
    ['nothing', ''],
    ['more than 300 characters', `https://jira.example.test/browse/PROJ-123${'/'.repeat(300)}`],
    ['something that is not text', { href: 'https://jira.example.test/browse/PROJ-123' }],
  ])('a URL with %s is not opened: unsupported', async (_name, url) => {
    const sdk = browserSdk();
    expect(await openTicket(sdk, ticket({ url, share: true }))).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.openUrl).not.toHaveBeenCalled();
    expect(sdk.promptShareScreen).not.toHaveBeenCalled();
  });

  test('arguments that are not exactly { url, key, share }: unsupported, nothing opened', async () => {
    const sdk = browserSdk();
    const bad = [
      null, undefined, 'PROJ-123', [], {},
      { url: URL_123, key: 'PROJ-123' },
      { url: URL_123, share: false },
      { key: 'PROJ-123', share: false },
      { url: URL_123, key: 'PROJ-123', share: 'true' },
      { url: URL_123, key: 'PROJ-123', share: 1 },
      { url: URL_123, key: 'PROJ-123', share: null },
      { url: URL_123, key: 'PROJ-123', share: false, target: '_self' },
      { url: URL_123, key: 'PROJ-123', share: false, shareSound: true },
      { url: URL_123, key: 5, share: false },
      { url: `${BASE}/browse/proj-123`, key: 'proj-123', share: false },
      { url: `${BASE}/browse/PROJ 123`, key: 'PROJ 123', share: false },
      { url: `${BASE}/browse/P-1`, key: 'P-1', share: false },
      { url: `${BASE}/browse/ABCDEFGHIJK-1`, key: 'ABCDEFGHIJK-1', share: false },
      { url: `${BASE}/browse/PROJ-12345678`, key: 'PROJ-12345678', share: false },
      { url: `${BASE}/browse/PROJ-123/../x`, key: 'PROJ-123/../x', share: false },
      { url: `${BASE}/browse/\u0420ROJ-123`, key: '\u0420ROJ-123', share: false },
      { url: `${BASE}/browse/PROJ-123\n`, key: 'PROJ-123\n', share: false },
    ];
    for (const args of bad) {
      expect(await openTicket(sdk, args)).toEqual({ ok: false, code: 'unsupported' });
    }
    expect(sdk.openUrl).not.toHaveBeenCalled();
  });

  test('without the deployment\'s base URL, or with one that is not a base URL, nothing is opened', async () => {
    const sdk = browserSdk();
    const bases = [
      undefined, null, '', 5, {}, 'http://jira.example.test', `${BASE}/`, `${BASE}?x=1`, `${BASE}#x`, 'https://user:secret@jira.example.test',
      'jira.example.test', 'https://', ` ${BASE}`,
    ];
    for (const jiraBaseUrl of bases) {
      const base = typeof jiraBaseUrl === 'string' ? jiraBaseUrl : BASE;
      expect(await openTicket(sdk, ticket({ url: `${base}/browse/PROJ-123` }), { jiraBaseUrl })).toEqual({ ok: false, code: 'unsupported' });
    }
    expect(await runArloAction(sdk, { tool: 'open_ticket', args: ticket() }, { stillAllowed: yes })).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.openUrl).not.toHaveBeenCalled();
  });

  test('the panel may no longer act: not_allowed, nothing opened and nothing shared', async () => {
    for (const stillAllowed of [() => false, () => 'yes', null, undefined]) {
      const sdk = browserSdk();
      expect(await openTicket(sdk, ticket({ share: true }), { stillAllowed })).toEqual({ ok: false, code: 'not_allowed' });
      expect(sdk.openUrl).not.toHaveBeenCalled();
      expect(sdk.promptShareScreen).not.toHaveBeenCalled();
    }
  });

  test('the panel stops being allowed while the browser opens: the ticket is open, the share dialog is not asked for', async () => {
    const sdk = browserSdk();
    let allowed = true;
    sdk.openUrl.mockImplementation(async () => { allowed = false; });
    expect(await openTicket(sdk, ticket({ share: true }), { stillAllowed: () => allowed })).toEqual({ ok: false, code: 'share_failed' });
    expect(sdk.openUrl).toHaveBeenCalledTimes(1);
    expect(sdk.promptShareScreen).not.toHaveBeenCalled();
  });

  test('share asked for and this client has no share dialog: the ticket is opened, and share_failed says the rest was not', async () => {
    const sdk = browserSdk();
    delete sdk.promptShareScreen;
    expect(await openTicket(sdk, ticket({ share: true }))).toEqual({ ok: false, code: 'share_failed' });
    expect(sdk.openUrl).toHaveBeenCalledWith({ url: URL_123 });
    // without share it is simply done
    expect(await openTicket(sdk, ticket())).toEqual({ ok: true });
  });

  test('the share dialog rejects, or throws at once: share_failed, and the ticket was opened once', async () => {
    const sdk = browserSdk();
    sdk.promptShareScreen.mockRejectedValueOnce(Object.assign(new Error('Failed to prompt share screen'), { code: '10143' }));
    expect(await openTicket(sdk, ticket({ share: true }))).toEqual({ ok: false, code: 'share_failed' });
    sdk.promptShareScreen.mockImplementationOnce(() => { throw new Error('not in a meeting'); });
    expect(await openTicket(sdk, ticket({ share: true }))).toEqual({ ok: false, code: 'share_failed' });
    expect(sdk.openUrl).toHaveBeenCalledTimes(2);
  });

  test('the browser cannot be opened (the domain is not on the app\'s allowlist), or throws: sdk_error, and nothing is shared', async () => {
    const sdk = browserSdk();
    sdk.openUrl.mockRejectedValueOnce(Object.assign(new Error('Request to open URL failed'), { code: '10015' }));
    expect(await openTicket(sdk, ticket({ share: true }))).toEqual({ ok: false, code: 'sdk_error' });
    sdk.openUrl.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(await openTicket(sdk, ticket({ share: true }))).toEqual({ ok: false, code: 'sdk_error' });
    expect(sdk.promptShareScreen).not.toHaveBeenCalled();
  });

  test('a client without openUrl: unsupported', async () => {
    const sdk = browserSdk();
    delete sdk.openUrl;
    expect(await openTicket(sdk, ticket({ share: true }))).toEqual({ ok: false, code: 'unsupported' });
    expect(sdk.promptShareScreen).not.toHaveBeenCalled();
  });

  test('announced when the client opens URLs and the deployment has a Jira; the share dialog is not needed for it', () => {
    expect(handsFor({ openUrlSupported: true, jiraBaseUrl: BASE, zoomRole: 'attendee' })).toEqual(['open_ticket']);
    expect(handsFor({ openUrlSupported: true, jiraBaseUrl: 'https://tools.example.test/jira', zoomRole: null })).toEqual(['open_ticket']);
    expect(handsFor({ chatSupported: true, openUrlSupported: true, jiraBaseUrl: BASE, zoomRole: 'host' })).toEqual(['post_to_chat', 'open_ticket']);
    expect(handsFor({ openUrlSupported: false, jiraBaseUrl: BASE, zoomRole: 'host' })).toEqual([]);
    expect(handsFor({ openUrlSupported: 'yes', jiraBaseUrl: BASE, zoomRole: 'host' })).toEqual([]);
    for (const jiraBaseUrl of [undefined, null, '', 'http://jira.example.test', `${BASE}/`, `${BASE}?x=1`, 'nonsense', 5, {}]) {
      expect(handsFor({ openUrlSupported: true, jiraBaseUrl, zoomRole: 'host' })).toEqual([]);
    }
    const all = {
      chatSupported: true, waitingRoomSupported: true, invitationSupported: true, reactionSupported: true, muteSupported: true,
      openUrlSupported: true, jiraBaseUrl: BASE,
    };
    expect(handsFor({ ...all, zoomRole: 'host' })).toHaveLength(6);
  });
});

test('a tool the panel does not have: unsupported, and nothing is called', async () => {
  const sdk = sdkWith();
  expect(await runArloAction(sdk, { tool: 'open_breakout_rooms', args: {} })).toEqual({ ok: false, code: 'unsupported' });
  expect(await runArloAction(sdk, { tool: 'constructor', args: {} })).toEqual({ ok: false, code: 'unsupported' });
  expect(await runArloAction(sdk, null)).toEqual({ ok: false, code: 'unsupported' });
  expect(sdk.sendMessageToChat).not.toHaveBeenCalled();
});
