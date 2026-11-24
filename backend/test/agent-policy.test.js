// Who gets what from Arlo: the policy as a table, and how a transcript
// speaker is (or is not) taken to be an owner.
// The environment is the tests' own (the speaker match reads the
// configuration), so this file runs without a developer's .env.
require('./helpers').setTestEnv();

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
  assert.equal(covers('please SHARE the notes', 'share_notes', {}), true);
  assert.equal(covers('please SHARE them', 'share_notes', {}), false);
  // the word, not a part of another one
  for (const typed of ['what did we decide?', 'who has the biggest shareholding?', 'unshared notes?', 'share_all']) {
    assert.equal(covers(typed, 'share_notes', {}), false, typed);
  }
  // asked not to: the sheet
  for (const typed of ['don\'t share the notes', 'do not share the notes yet', 'never share them', 'stop, no share', 'Don’t share the notes']) {
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
    ['send_reaction', { reaction: 'thumbs_up' }, 'send a thumbs up', 'what did we decide?'],
    ['mute_participant', { name: 'Danny' }, 'mute Danny', 'who is talking?'],
    // inviting is never covered: see the next test
    ['invite_everyone', {}, null, 'Invite everyone to see the notes'],
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
    if (covered !== null) assert.equal(typedRequestCovers(covered, name, args), true, `${name} covered`);
    assert.equal(typedRequestCovers(notCovered, name, args), false, `${name} not covered`);
    // typed by someone who is not an owner: the sheet under "anyone", refused otherwise
    assert.equal(decide({ channel: 'panel', asker: 'other', whoCanAsk: 'anyone', toolKind }), 'sheet', name);
    assert.equal(decide({ channel: 'panel', asker: 'other', whoCanAsk: 'owner', toolKind }), 'refuse', name);
  }
});

test('inviting everyone is never covered by what was typed: it shares the notes too, and the sheet says both', () => {
  const covers = (typed) => typedRequestCovers(typed, 'invite_everyone', {});
  for (const typed of [
    'invite everyone', 'Please INVITE them all to open Arlo', 'can you invite the room', 'everyone should be invited',
    'share the notes and invite everyone', 'share the notes', 'what did we decide?', 'uninvite everyone', '', 5, null,
  ]) {
    assert.equal(covers(typed), false, String(typed));
  }
});

test('a reaction is covered by a word for that reaction, and not by a word for another', () => {
  const WORDS = {
    thumbs_up: ['give that a thumbs up', 'THUMB UP', 'thumbs-up please'],
    clap: ['clap for her', 'a round of applause', 'Applaud that', 'clapping!'],
    heart: ['send a heart', 'I love that'],
    joy: ['laugh at that', 'send the joy one', 'that deserves laughing'],
    tada: ['celebrate that', 'party time', 'tada', 'Celebration please'],
    open_mouth: ['wow', 'look surprised', 'what a surprise', 'Wow!'],
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

test('a reaction\'s word counts only as a whole word, and never after a "not"', () => {
  const covers = (typed, reaction) => typedRequestCovers(typed, 'send_reaction', { reaction });
  // inside another word, or half of a compound: not the word
  for (const [typed, reaction] of [
    ['where is my glove?', 'heart'], ['pass the cloves', 'heart'], ['heartburn again', 'heart'], ['a broken heart', 'heart'],
    ['wowza', 'open_mouth'], ['wow-factor', 'open_mouth'], ['unsurprised', 'open_mouth'],
    ['a third-party tool', 'tada'], ['a third party tool', 'tada'], ['the party_line', 'tada'],
    ['I enjoy this', 'joy'], ['enjoy', 'joy'], ['Joyce said so', 'joy'],
    ['use the thumbnail', 'thumbs_up'], ['thumb it', 'thumbs_up'], ['thumbs', 'thumbs_up'], ['thumbs down', 'thumbs_up'],
    ['give that a thumbs down, not up', 'thumbs_up'], ['clapton is playing', 'clap'], ['a thunderclap', 'clap'],
  ]) {
    assert.equal(covers(typed, reaction), false, typed);
  }
  // asked not to: the sheet
  for (const [typed, reaction] of [
    ['don\'t send a thumbs up', 'thumbs_up'], ['Don’t send a thumbs up', 'thumbs_up'], ['do not clap', 'clap'], ['never clap', 'clap'],
    ['no heart please', 'heart'], ['stop the party', 'tada'], ['not a wow', 'open_mouth'], ['dont laugh', 'joy'],
    ['I can\'t laugh at that', 'joy'], ['please do NOT send a heart', 'heart'], ['a thumbs up? no', 'thumbs_up'],
  ]) {
    assert.equal(covers(typed, reaction), false, typed);
  }
  // an invisible character does not hide what is there
  assert.equal(covers('do n\u00ADot clap', 'clap'), false);
  assert.equal(covers('c\u200Blap', 'clap'), true);
});

test('muting is covered only by a plain "mute <the whole name>"', () => {
  const covers = (typed, name = 'Danny Lee') => typedRequestCovers(typed, 'mute_participant', { name });
  for (const typed of [
    'mute Danny Lee', 'Mute Danny Lee.', 'MUTE   danny\tlee!', 'please mute Danny Lee', 'mute Danny Lee please', 'mute Danny Lee, please.',
    'Arlo, mute Danny Lee', 'arlo mute Danny Lee', 'Arlo, please mute Danny Lee', 'can you mute Danny Lee', 'Could you mute Danny Lee please',
    'Arlo, can you please mute Danny Lee!', 'ｍｕｔｅ Danny Lee', 'Hey Arlo, mute Danny Lee', 'hey arlo would you mute Danny Lee?',
    'can you mute Danny Lee?', 'Could you please mute Danny Lee, please?',
  ]) {
    assert.equal(covers(typed), true, typed);
  }
  assert.equal(covers('mute Danny Reyes', 'danny  reyes'), true);
  assert.equal(covers('mute Danny', 'Danny'), true);
  assert.equal(covers('mute D. Lee Jr.', 'D. Lee Jr.'), true);
  // the name as a whole: not a part of it, not a part of the request
  for (const name of ['Danny', 'Lee', 'an', 'mute', 'e', 'mute Danny Lee', 'Danny Lee Jr', 'Dan']) {
    assert.equal(covers('mute Danny Lee', name), false, name);
  }
  // anything but the plain request
  for (const typed of [
    'is Danny Lee here?', 'mute him', 'mute Dan', 'mute everyone except Danny Lee', 'don\'t mute Danny Lee', 'do not mute Danny Lee',
    'is Danny Lee muted?', 'take Danny Lee off mute', 'de-mute Danny Lee', 'un_mute Danny Lee', 'un.mute Danny Lee', 'unmute Danny Lee',
    'mute Danny Lee and Sam', 'mute Danny Lee, he is loud', 'never mute Danny Lee', 'mute Danny Lee?', 'please mute Danny Lee?', 'mute Danny Lee not', 'Danny Lee mute',
    'mute  ', 'mute', 'please', 'mute Danny Lee please please', 'Sam, mute Danny Lee',
  ]) {
    assert.equal(covers(typed), false, typed);
  }
  // "unmute" is another thing: never covered, however it is written
  for (const typed of [
    'unmute Danny Lee', 'Unmute Danny Lee please', 'UNMUTE danny lee', 'un-mute Danny Lee', 'un mute Danny Lee',
    'mute Danny Lee, no wait, unmute Danny Lee', 'unmute Danny Lee and mute Danny Lee',
    // an invisible character between "un" and "mute", or inside either
    'un\u00ADmute Danny Lee', 'un\u200Bmute Danny Lee', 'un\u200Cmute Danny Lee', 'un\u200Dmute Danny Lee', 'u\u2060n\uFEFFmute Danny Lee',
    'un\u202Emute Danny Lee', '\u200Bun mute Danny Lee',
  ]) {
    assert.equal(covers(typed), false, JSON.stringify(typed));
  }
  // an invisible character does not make another request of a plain one
  assert.equal(covers('mu\u00ADte Danny\u200B Lee'), true);
  for (const [typed, args] of [['mute', { name: '' }], ['mute', { name: '  ' }], ['mute x', {}], ['mute x', { name: 5 }], ['mute x', null], [5, { name: '5' }]]) {
    assert.equal(typedRequestCovers(typed, 'mute_participant', args), false, JSON.stringify([typed, args]));
  }
});

test('admitting is covered only by a plain "admit <the whole name>" or "let <the whole name> in"', () => {
  const covers = (typed, name = 'James Carter') => typedRequestCovers(typed, 'admit_from_waiting_room', { name });
  for (const typed of [
    'admit James Carter', 'Admit James Carter.', 'let James Carter in', 'Let  JAMES carter in!', 'admit James Carter from the waiting room',
    'let James Carter in from the waiting room', 'please admit James Carter', 'Arlo, let James Carter in please', 'can you admit James Carter',
    'could you let James Carter in, please.',
  ]) {
    assert.equal(covers(typed), true, typed);
  }
  for (const name of ['James', 'Carter', 'am', 'admit', 'in', 'James Carter in', 'James Carter Jr']) {
    assert.equal(covers('admit James Carter', name), false, name);
    assert.equal(covers('let James Carter in', name), false, name);
  }
  for (const typed of [
    'who is waiting? James Carter?', 'don\'t admit James Carter', 'do not let James Carter in', 'admit everyone except James Carter',
    'admit James Carter and Mallory', 'let James Carter and Mallory in', 'is James Carter admitted?', 'never let James Carter in',
    'readmit James Carter', 'admit James Carter?', 'let James Carter', 'James Carter in', 'let James Carter out', 'let James Carter in on it',
    'ad\u00ADmit everyone but James Carter', 'admit',
  ]) {
    assert.equal(covers(typed), false, typed);
  }
  assert.equal(covers('ad\u00ADmit James\u200B Carter'), true);
});

test('opening a ticket with the share dialog is not covered when the typed text says not to', () => {
  const covers = (typed, share) => typedRequestCovers(typed, 'open_ticket', { key: 'PROJ-123', share });
  assert.equal(covers('open PROJ-123 and share it', true), true);
  assert.equal(covers('open PROJ-123', false), true);
  assert.equal(covers('open PROJ-123', true), false);
  for (const typed of [
    'open PROJ-123, don\'t share', 'open PROJ-123 but do not share it', 'open PROJ-123 and never share it', 'open PROJ-123, no share',
    'open PROJ-123 and stop sharing', 'open PROJ-123, don’t share', 'open PROJ-123, dont share', 'open PROJ-123 without sharing',
    'open PROJ-123, do n\u00ADot share',
  ]) {
    assert.equal(covers(typed, true), false, typed);
  }
  // a word that turns the request around: the sheet, with or without the share dialog
  assert.equal(covers('open PROJ-123, don\'t share', false), false);
  assert.equal(covers('open PROJ-123 and share it', false), true);
});

test('sharing the notes is covered only by the plain request, whole', () => {
  const covers = (typed) => typedRequestCovers(typed, 'share_notes', {});
  for (const typed of [
    'share the notes', 'Share notes', 'share Arlo\'s notes', 'share Arlo’s notes', 'share my notes', 'share the notes with everyone',
    'share notes with everybody', 'share my notes with the meeting', 'share the notes with all', 'Arlo, please share the notes.',
    'Hey Arlo, share the notes!', 'can you share the notes?', 'could you share the notes with everyone, please?', 'would you share notes',
  ]) assert.equal(covers(typed), true, typed);
  for (const typed of [
    'share the notes with Danny only', 'share the notes with Danny', 'un-share the notes', 'unshare the notes', 'should I share the notes?',
    'share the notes?', 'share my screen', 'share', 'share them', 'share the notes with everyone except Sam', 'share the notes later',
    'who can share the notes', 'share the notes and post them', 'stop, share the notes', 'dont share the notes', 'share the notes instead',
    'are the notes shared?', 'share the notes with everyone but not yet', 'share the notes with nobody', 'never mind, share the notes',
  ]) assert.equal(covers(typed), false, typed);
});

test('posting is covered only when the typed text is a verb, the message once, the chat at most, and nothing else', () => {
  const covers = (typed, message) => typedRequestCovers(typed, 'post_to_chat', { message });
  for (const [typed, message] of [
    ['post hello team', 'hello team'], ['Post Hello Team', 'hello team'], ['post "hello team"', 'hello team'], ['post: hello team', 'hello team'],
    ['say hello team', 'hello team'], ['write hello team in the chat', 'hello team'], ['send hello team to the meeting chat', 'hello team'],
    ['put hello team into chat', 'hello team'], ['post this in the chat: hello team', 'hello team'], ['post to chat, hello team', 'hello team'],
    ['post that: “hello team”', 'hello team'], ['Arlo, please post hello team', 'hello team'], ['hey arlo, post hello team please', 'hello team'],
    ['can you post hello team in the chat?', 'hello team'], ['post hello team.', 'hello team'], ['post do not disturb', 'do not disturb'],
    ['Post Lunch at noon in the chat', 'Lunch at noon'],
  ]) assert.equal(covers(typed, message), true, typed);
  for (const [typed, message] of [
    ['dont post hello team', 'hello team'], ['don\'t post hello team', 'hello team'], ['do not post hello team', 'hello team'],
    ['never post hello team', 'hello team'], ['what does hello mean', 'hello'], ['hello', 'hello'], ['hello team', 'hello team'],
    ['post hello team and hello team again', 'hello team'], ['post hello hello', 'hello'], ['post hello team to Danny', 'hello team'],
    ['post hello team in the chat in the chat', 'hello team'], ['post in the chat hello team in the chat', 'hello team'],
    ['should I post hello team?', 'hello team'], ['post hello team?', 'hello team'], ['post hello teams', 'hello team'],
    ['repost hello team', 'hello team'], ['post hello team unless Sam objects', 'hello team'], ['delete hello team', 'hello team'],
    ['post hello team instead of the notes', 'hello team'], ['post something like hello team', 'hello team'],
    ['Sam said post hello team', 'hello team'], ['post \u0001 hello team', 'hello team'], ['post the notes', 'Buy now at evil.example'],
  ]) assert.equal(covers(typed, message), false, typed);
});

test('opening a ticket needs a word that opens, and sharing the word "share" itself', () => {
  const covers = (typed, share, key = 'PROJ-123') => typedRequestCovers(typed, 'open_ticket', { key, share });
  for (const typed of ['open PROJ-123', 'pull up PROJ-123', 'bring up PROJ-123 please', 'show PROJ-123', 'Hey Arlo, show me proj-123']) {
    assert.equal(covers(typed, false), true, typed);
  }
  for (const typed of [
    'close PROJ-123', 'what is PROJ-123 about', 'PROJ-123', 'reopen PROJ-123', 'who opened PROJ-123', 'dont open PROJ-123',
    'open PROJ-123 unless it is closed', 'never show PROJ-123', 'open nothing but PROJ-123', 'delete PROJ-123',
  ]) {
    assert.equal(covers(typed, false), false, typed);
    assert.equal(covers(`${typed} and share it`, true), false, typed);
  }
  for (const typed of [
    'open PROJ-123 and share it', 'open PROJ-123 and start sharing', 'open PROJ-123 and screen share it', 'open PROJ-123 and screenshare',
    'open PROJ-123, screen-share it', 'show PROJ-123 and share my screen',
  ]) assert.equal(covers(typed, true), true, typed);
  for (const typed of [
    'open PROJ-123 on the shared drive', 'open PROJ-123 from the shares list', 'open PROJ-123 for the shareholders', 'open PROJ-123',
    'open PROJ-123 and un-share', 'open PROJ-123 and unshare', 'open PROJ-123 and stop sharing', 'open PROJ-123 instead of sharing',
    'share PROJ-123',
  ]) assert.equal(covers(typed, true), false, typed);
  // words and a number are not a key
  assert.equal(covers('open PROJ-12 in 5 minutes', false, 'IN-5'), false);
  assert.equal(covers('open PROJ-12 in 5 minutes', false, 'PROJ-12'), true);
  assert.equal(covers('open ticket 42', false, 'TICKET-42'), false);
  assert.equal(covers('show version 2', false, 'VERSION-2'), false);
  assert.equal(covers('open PROJ 123', false), true);
  assert.equal(covers('open proj 123', false), false);
});

test('the words that turn a request around, with and without an apostrophe', () => {
  for (const word of [
    'not', 'no', 'never', 'stop', 'without', 'cannot', 'dont', 'don\'t', 'cant', 'can\'t', 'wont', 'won\'t', 'shouldnt', 'shouldn\'t',
    'wouldnt', 'couldnt', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'avoid', 'skip', 'unless', 'instead', 'rather', 'nobody', 'nothing',
    'none', 'neither', 'nor',
  ]) {
    assert.equal(typedRequestCovers(`${word} clap`, 'send_reaction', { reaction: 'clap' }), false, word);
    assert.equal(typedRequestCovers(`open PROJ-123 ${word}`, 'open_ticket', { key: 'PROJ-123', share: false }), false, word);
  }
  // not a part of another word
  for (const typed of ['clap for the notary', 'clap, north side', 'nonesuch clap']) {
    assert.equal(typedRequestCovers(typed, 'send_reaction', { reaction: 'clap' }), true, typed);
  }
});

test('a reaction is covered by its own emoji too, and not by another\'s', () => {
  const EMOJI = {
    thumbs_up: ['\u{1F44D}'], clap: ['\u{1F44F}'], heart: ['❤️', '❤'], joy: ['\u{1F602}'], tada: ['\u{1F389}'], open_mouth: ['\u{1F62E}'],
  };
  for (const [reaction, list] of Object.entries(EMOJI)) {
    for (const emoji of list) {
      for (const other of Object.keys(EMOJI)) {
        assert.equal(typedRequestCovers(`send a ${emoji}`, 'send_reaction', { reaction: other }), other === reaction, `${emoji} / ${other}`);
        assert.equal(typedRequestCovers(emoji, 'send_reaction', { reaction: other }), other === reaction, `${emoji} / ${other}`);
      }
      assert.equal(typedRequestCovers(`don't send a ${emoji}`, 'send_reaction', { reaction }), false);
      assert.equal(typedRequestCovers(`no ${emoji}`, 'send_reaction', { reaction }), false);
    }
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
