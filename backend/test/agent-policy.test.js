// Who gets what from Arlo: the policy as a table, and how a transcript
// speaker is (or is not) taken to be an owner.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decide, panelMayAsk, voiceIsHeard, typedRequestCovers,
} = require('../src/services/agent/policy');
const { createSpeakerMatch, readSpeakerMatchMode, SPEAKER_MATCH_MODES } = require('../src/services/agent/speakerMatch');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');

// channel, asker, whoCanAsk, toolKind -> outcome. Every combination is here.
// asker 'owner': typed by an owner in their panel, or spoken by a speaker
// verified to be an owner. 'other': anyone else.
// A typed request no tool fits is answered from the transcript as typed
// ('answer'), for whoever may type at all. The spoken rows hold while an
// owner has a panel open; without one every spoken row is 'silent' (below).
// Nothing spoken runs without the sheet: not for a verified owner, and not
// where anyone may ask.
const TABLE = [
  ['panel', 'owner', 'owner', 'read', 'run'],
  ['panel', 'owner', 'owner', 'change', 'run'],
  ['panel', 'owner', 'owner', 'none', 'answer'],
  ['panel', 'owner', 'anyone', 'read', 'run'],
  ['panel', 'owner', 'anyone', 'change', 'run'],
  ['panel', 'owner', 'anyone', 'none', 'answer'],
  ['panel', 'other', 'owner', 'read', 'refuse'],
  ['panel', 'other', 'owner', 'change', 'refuse'],
  ['panel', 'other', 'owner', 'none', 'refuse'],
  ['panel', 'other', 'anyone', 'read', 'run'],
  ['panel', 'other', 'anyone', 'change', 'sheet'],
  ['panel', 'other', 'anyone', 'none', 'answer'],
  ['voice', 'owner', 'owner', 'read', 'sheet'],
  ['voice', 'owner', 'owner', 'change', 'sheet'],
  ['voice', 'owner', 'owner', 'none', 'silent'],
  ['voice', 'owner', 'anyone', 'read', 'sheet'],
  ['voice', 'owner', 'anyone', 'change', 'sheet'],
  ['voice', 'owner', 'anyone', 'none', 'silent'],
  ['voice', 'other', 'owner', 'read', 'sheet'],
  ['voice', 'other', 'owner', 'change', 'sheet'],
  ['voice', 'other', 'owner', 'none', 'silent'],
  ['voice', 'other', 'anyone', 'read', 'sheet'],
  ['voice', 'other', 'anyone', 'change', 'sheet'],
  ['voice', 'other', 'anyone', 'none', 'silent'],
];

test('the policy, every combination', () => {
  assert.equal(TABLE.length, 2 * 2 * 2 * 3);
  assert.equal(new Set(TABLE.map((row) => row.slice(0, 4).join())).size, TABLE.length);
  for (const [channel, asker, whoCanAsk, toolKind, outcome] of TABLE) {
    const facts = { channel, asker, whoCanAsk, toolKind };
    const row = `${channel} ${asker} ${whoCanAsk} ${toolKind}`;
    assert.equal(decide({ ...facts, ownerPanelOpen: true }), outcome, row);
    // No owner has a panel open: nothing spoken is done, shown or asked about.
    // A typed request does not depend on it.
    for (const ownerPanelOpen of [false, undefined, null, 'true', 1]) {
      assert.equal(decide({ ...facts, ownerPanelOpen }), channel === 'voice' ? 'silent' : outcome, `${row}, panel ${String(ownerPanelOpen)}`);
    }
  }
});

test('nothing spoken is ever "run": the policy has no way to it', () => {
  for (const asker of ['owner', 'other', 'host', undefined]) {
    for (const whoCanAsk of ['owner', 'anyone', undefined]) {
      for (const toolKind of ['read', 'change', 'none', 'admin']) {
        assert.notEqual(decide({ channel: 'voice', asker, whoCanAsk, toolKind, ownerPanelOpen: true }), 'run');
      }
    }
  }
});

test('an owner\'s typed request covers a change only when what would be done is in what they typed', () => {
  const covers = (typed, tool, args) => typedRequestCovers(typed, tool, args);
  assert.equal(covers('Post "Back in five." to the chat', 'post_to_chat', { message: 'Back in five.' }), true);
  assert.equal(covers('post   BACK in\nfive to the chat', 'post_to_chat', { message: 'back in  FIVE' }), true);
  assert.equal(covers('what did we decide?', 'post_to_chat', { message: 'Install https://evil.example' }), false);
  assert.equal(covers('post back in five', 'post_to_chat', { message: 'back in five minutes' }), false);
  assert.equal(covers('let James Carter in', 'admit_from_waiting_room', { name: 'james carter' }), true);
  assert.equal(covers('who is waiting?', 'admit_from_waiting_room', { name: 'Mallory' }), false);
  assert.equal(covers('Share the notes', 'share_notes', {}), true);
  assert.equal(covers('please SHARE them', 'share_notes', {}), true);
  // the word, not a part of another one
  for (const typed of ['what did we decide?', 'who has the biggest shareholding?', 'unshared notes?', 'share_all']) {
    assert.equal(covers(typed, 'share_notes', {}), false, typed);
  }
  // nothing to compare, another tool, or something that is not text: not covered
  for (const [typed, tool, args] of [
    ['post it', 'post_to_chat', { message: '' }], ['post it', 'post_to_chat', { message: '   ' }], ['post it', 'post_to_chat', {}],
    ['post it', 'post_to_chat', null], ['post it', 'post_to_chat', { message: 5 }], [5, 'post_to_chat', { message: '5' }],
    [undefined, 'share_notes', {}], ['delete everything', 'delete_everything', {}], ['share', 'web_search', { query: 'share' }],
    ['admit', 'admit_from_waiting_room', { message: 'admit' }],
  ]) {
    assert.equal(covers(typed, tool, args), false, JSON.stringify([typed, tool, args]));
  }
});

// Inviting everyone, sending a reaction and muting someone change the meeting:
// the policy treats each as a 'change', so what happens depends on who asked
// and how, and for an owner's typed request on whether it is covered.
const { getTool } = require('../src/services/agent/tools');

test('the three tools that act in the meeting: sheet for speech and for someone who is not an owner, run only for a covered typed request', () => {
  const calls = [
    ['invite_everyone', {}, 'Invite everyone to see the notes', 'what did we decide?'],
    ['send_reaction', { reaction: 'thumbs_up' }, 'send a thumbs up', 'what did we decide?'],
    ['mute_participant', { name: 'Danny' }, 'mute Danny', 'who is talking?'],
  ];
  for (const [name, args, covered, notCovered] of calls) {
    const tool = getTool(name);
    assert.deepEqual([tool.runs, tool.changesMeeting], ['panel', true], name);
    const toolKind = tool.changesMeeting ? 'change' : 'read';
    // spoken: the sheet, whoever spoke and whatever the setting
    for (const asker of ['owner', 'other']) {
      for (const whoCanAsk of ['owner', 'anyone']) {
        assert.equal(decide({ channel: 'voice', asker, whoCanAsk, toolKind, ownerPanelOpen: true }), 'sheet', name);
        assert.equal(decide({ channel: 'voice', asker, whoCanAsk, toolKind, ownerPanelOpen: false }), 'silent', name);
      }
    }
    // typed by an owner: run, and then only when covered
    assert.equal(decide({ channel: 'panel', asker: 'owner', whoCanAsk: 'owner', toolKind }), 'run', name);
    assert.equal(typedRequestCovers(covered, name, args), true, `${name} covered`);
    assert.equal(typedRequestCovers(notCovered, name, args), false, `${name} not covered`);
    // typed by someone who is not an owner: the sheet under "anyone", refused otherwise
    assert.equal(decide({ channel: 'panel', asker: 'other', whoCanAsk: 'anyone', toolKind }), 'sheet', name);
    assert.equal(decide({ channel: 'panel', asker: 'other', whoCanAsk: 'owner', toolKind }), 'refuse', name);
  }
});

test('inviting is covered by the word "invite" in what was typed', () => {
  const covers = (typed) => typedRequestCovers(typed, 'invite_everyone', {});
  for (const typed of ['invite everyone', 'Please INVITE them all to open Arlo', 'can you invite the room', 'everyone should be invited']) {
    assert.equal(covers(typed), true, typed);
  }
  for (const typed of ['share the notes', 'what did we decide?', 'uninvite everyone', 'disinvite them', 'in vite', '', 5, null]) {
    assert.equal(covers(typed), false, String(typed));
  }
});

test('a reaction is covered by a word for that reaction, and not by a word for another', () => {
  const WORDS = {
    thumbs_up: ['give that a thumbs up', 'THUMB it'],
    clap: ['clap for her', 'a round of applause', 'Applaud that'],
    heart: ['send a heart', 'I love that'],
    joy: ['laugh at that', 'send the joy one', 'that deserves laughing'],
    tada: ['celebrate that', 'party time', 'tada', 'Celebration please'],
    open_mouth: ['wow', 'look surprised', 'what a surprise'],
  };
  for (const [reaction, typed] of Object.entries(WORDS)) {
    for (const text of typed) {
      for (const other of Object.keys(WORDS)) {
        assert.equal(typedRequestCovers(text, 'send_reaction', { reaction: other }), other === reaction, `${text} / ${other}`);
      }
    }
  }
  // a reaction that is not in the table, or none, is never covered
  for (const args of [{ reaction: 'skull' }, { reaction: 'constructor' }, { reaction: '__proto__' }, { reaction: 'toString' }, { reaction: 5 }, { reaction: null }, {}, null]) {
    assert.equal(typedRequestCovers('send a thumbs up clap heart laugh party wow constructor toString', 'send_reaction', args), false, JSON.stringify(args));
  }
  assert.equal(typedRequestCovers('react to that', 'send_reaction', { reaction: 'thumbs_up' }), false);
});

test('muting is covered only when the name and the word "mute" are typed, and never by "unmute"', () => {
  const covers = (typed, name = 'Danny') => typedRequestCovers(typed, 'mute_participant', { name });
  assert.equal(covers('mute Danny'), true);
  assert.equal(covers('Please MUTE   danny, he is loud'), true);
  assert.equal(covers('mute Danny Reyes', 'danny  reyes'), true);
  // the name without "mute", or "mute" without the name
  assert.equal(covers('is Danny here?'), false);
  assert.equal(covers('mute him'), false);
  assert.equal(covers('mute Dan'), false);
  // "unmute" is another thing: never covered, however it is written
  for (const typed of ['unmute Danny', 'Unmute Danny please', 'UNMUTE danny', 'un-mute Danny', 'un mute Danny', 'mute Danny, no wait, unmute Danny', 'unmute Danny and mute Danny']) {
    assert.equal(covers(typed), false, typed);
  }
  for (const [typed, args] of [['mute', { name: '' }], ['mute', { name: '  ' }], ['mute x', {}], ['mute x', { name: 5 }], ['mute x', null], [5, { name: '5' }]]) {
    assert.equal(typedRequestCovers(typed, 'mute_participant', args), false, JSON.stringify([typed, args]));
  }
});

test('a spoken request is heard only while an owner has a panel open', () => {
  assert.equal(voiceIsHeard({ ownerPanelOpen: true }), true);
  for (const ownerPanelOpen of [false, undefined, null, 'true', 1, {}]) assert.equal(voiceIsHeard({ ownerPanelOpen }), false);
  assert.equal(voiceIsHeard(), false);
  assert.equal(voiceIsHeard(null), false);
});

test('anything the policy does not know is refused (typed) or silent (spoken), never run', () => {
  const good = { channel: 'panel', asker: 'owner', whoCanAsk: 'anyone', toolKind: 'change' };
  for (const bad of [
    { channel: 'chat' }, { channel: undefined }, { asker: 'host' }, { asker: true }, { asker: undefined },
    { whoCanAsk: 'everyone' }, { whoCanAsk: undefined }, { toolKind: 'write' }, { toolKind: undefined },
  ]) {
    assert.equal(decide({ ...good, ...bad }), 'refuse', JSON.stringify(bad));
  }
  assert.equal(decide({ ...good, channel: 'voice', asker: 'verified', ownerPanelOpen: true }), 'silent');
  assert.equal(decide({ ...good, channel: 'voice', toolKind: 'anything', ownerPanelOpen: true }), 'silent');
  // an unknown setting is the stricter one
  assert.equal(decide({ channel: 'voice', asker: 'other', whoCanAsk: 'everyone', toolKind: 'read', ownerPanelOpen: true }), 'sheet');
  // a typed request with a tool kind that is not known is not answered from the transcript either
  assert.equal(decide({ ...good, toolKind: undefined }), 'refuse');
  assert.equal(decide(), 'refuse');
  assert.equal(decide(null), 'refuse');
});

test('who may type a request at all', () => {
  assert.equal(panelMayAsk({ asker: 'owner', whoCanAsk: 'owner' }), true);
  assert.equal(panelMayAsk({ asker: 'owner', whoCanAsk: 'anyone' }), true);
  assert.equal(panelMayAsk({ asker: 'other', whoCanAsk: 'anyone' }), true);
  assert.equal(panelMayAsk({ asker: 'other', whoCanAsk: 'owner' }), false);
  assert.equal(panelMayAsk({ asker: 'other', whoCanAsk: 'x' }), false);
  assert.equal(panelMayAsk({}), false);
});

const M = 'MEETING-SPEAKER==';
function withIdentities() {
  const store = createMemoryMeetingStore();
  store.appendSegment(M, { text: 'hello' });
  store.setIdentity(M, 'user-ana', { participantUUID: 'UUID-ANA', participantId: '16778240', screenName: 'Ana Ruiz' });
  store.setIdentity(M, 'user-cy', { participantId: '16779999' });
  return store;
}

test('the three ways of matching a speaker; none is the default', () => {
  assert.deepEqual([...SPEAKER_MATCH_MODES], ['none', 'participant_id', 'participant_uuid']);
  const store = withIdentities();

  for (const mode of ['none', undefined, 'name', 'screen_name', '', null, 5]) {
    const is = createSpeakerMatch({ mode, store });
    for (const speakerId of ['16778240', 'UUID-ANA', '16779999']) {
      assert.equal(is(M, { speakerId, speakerLabel: 'Ana Ruiz' }), false, `${String(mode)} ${speakerId}`);
    }
  }

  const byId = createSpeakerMatch({ mode: 'participant_id', store });
  assert.equal(byId(M, { speakerId: '16778240', speakerLabel: 'Someone' }), true);
  assert.equal(byId(M, { speakerId: ' 16779999 ', speakerLabel: null }), true);
  assert.equal(byId(M, { speakerId: 'UUID-ANA', speakerLabel: 'Ana Ruiz' }), false);
  assert.equal(byId(M, { speakerId: '1', speakerLabel: 'Ana Ruiz' }), false);

  const byUuid = createSpeakerMatch({ mode: 'participant_uuid', store });
  assert.equal(byUuid(M, { speakerId: 'UUID-ANA', speakerLabel: 'x' }), true);
  assert.equal(byUuid(M, { speakerId: '16778240', speakerLabel: 'Ana Ruiz' }), false);
});

test('a name never makes a speaker an owner, and nothing matches without an id', () => {
  const store = withIdentities();
  for (const mode of SPEAKER_MATCH_MODES) {
    const is = createSpeakerMatch({ mode, store });
    assert.equal(is(M, { speakerId: 'Ana Ruiz', speakerLabel: 'Ana Ruiz' }), false);
    assert.equal(is(M, { speakerId: null, speakerLabel: 'Ana Ruiz' }), false);
    for (const speakerId of ['', '   ', 'unknown', null, undefined, 16778240, {}, ['16778240']]) {
      assert.equal(is(M, { speakerId, speakerLabel: 'Ana Ruiz' }), false, JSON.stringify(speakerId));
    }
    assert.equal(is(M, null), false);
    assert.equal(is(M), false);
    // another meeting's identities are not this meeting's
    assert.equal(is('ANOTHER==', { speakerId: '16778240' }), false);
  }
  // an identity without that field (null) never equals a speaker
  store.setIdentity(M, 'user-dee', { screenName: 'Dee' });
  assert.equal(createSpeakerMatch({ mode: 'participant_id', store })(M, { speakerId: 'null' }), false);
});

test('a store that fails verifies nobody', () => {
  const is = createSpeakerMatch({ mode: 'participant_id', store: { listIdentities: () => { throw new Error('down'); } } });
  assert.equal(is(M, { speakerId: '16778240' }), false);
});

test('AGENT_SPEAKER_MATCH: the three values, and anything else is none', () => {
  for (const mode of SPEAKER_MATCH_MODES) assert.deepEqual(readSpeakerMatchMode(mode), { mode, known: true });
  for (const unset of [undefined, null, '']) assert.deepEqual(readSpeakerMatchMode(unset), { mode: 'none', known: true });
  for (const bad of ['name', 'screen_name', 'PARTICIPANT_ID', ' participant_id', 'true', '1', 5, {}, ['participant_id']]) {
    assert.deepEqual(readSpeakerMatchMode(bad), { mode: 'none', known: false }, JSON.stringify(bad));
  }
});
