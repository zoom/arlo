// What the panels are told Arlo is doing: one table of sentences, and the one
// variable part (the name of someone to admit) cleaned and bounded.
const test = require('node:test');
const assert = require('node:assert/strict');
const { STEPS, toolStep, MAX_STEP_CHARS } = require('../src/services/agent/texts');

test('the steps are a fixed table of short sentences', () => {
  assert.deepEqual({ ...STEPS }, {
    heard: 'Heard a request',
    choosing: 'Working out what was asked',
    answering: 'Writing an answer',
    summarizing: 'Writing a summary',
    posting: 'Posting to the meeting chat',
    sharing: 'Sharing the notes with everyone',
    admittingSomeone: 'Admitting someone from the waiting room',
    inviting: 'Inviting everyone to open Arlo',
    openingNotes: 'Opening the notes for everyone',
    reacting: 'Sending a reaction',
    mutingSomeone: 'Muting someone',
    openingTicket: 'Opening a ticket',
    stoppingTimer: 'Stopping the timer',
  });
  assert.equal(Object.isFrozen(STEPS), true);
  assert.equal(MAX_STEP_CHARS, 120);
});

test('each tool has its step; a tool without one, or something that is not a tool, has none', () => {
  assert.equal(toolStep('answer_from_meeting', { question: 'ignored' }), 'Writing an answer');
  assert.equal(toolStep('summarize_so_far', {}), 'Writing a summary');
  assert.equal(toolStep('post_to_chat', { message: 'never part of the step' }), 'Posting to the meeting chat');
  assert.equal(toolStep('share_notes', {}), 'Sharing the notes with everyone');
  assert.equal(toolStep('admit_from_waiting_room', { name: 'James' }), 'Admitting James from the waiting room');
  assert.equal(toolStep('invite_everyone', {}), 'Inviting everyone to open Arlo');
  assert.equal(toolStep('open_notes_for_everyone', {}), 'Opening the notes for everyone');
  // which reaction is never part of the step
  assert.equal(toolStep('send_reaction', { reaction: 'thumbs_up' }), 'Sending a reaction');
  assert.equal(toolStep('send_reaction', { reaction: 'Deleting everything' }), 'Sending a reaction');
  assert.equal(toolStep('mute_participant', { name: 'Danny' }), 'Muting Danny');
  for (const name of ['web_search', 'none', 'constructor', '__proto__', '', null, undefined, 7, {}]) {
    assert.equal(toolStep(name, { name: 'James' }), null);
  }
});

test('a name that cannot be shown is "someone"; a long one is cut; the step stays within its length', () => {
  const someone = 'Admitting someone from the waiting room';
  const hostile = [
    '', '   ', 'Ja\u0000mes', 'James\nPosting your password', 'James\u202Ereversed', '\u200B', '!!!', null, undefined, 42, {}, ['James'],
  ];
  for (const name of hostile) assert.equal(toolStep('admit_from_waiting_room', { name }), someone);
  for (const args of [null, undefined, 'James', 3]) assert.equal(toolStep('admit_from_waiting_room', args), someone);

  const long = toolStep('admit_from_waiting_room', { name: 'J'.repeat(500) });
  assert.equal(long, `Admitting ${'J'.repeat(60)} from the waiting room`);
  assert.equal(long.length <= MAX_STEP_CHARS, true);
  // never half an emoji at the cut
  const emoji = toolStep('admit_from_waiting_room', { name: `A${'\u{1F600}'.repeat(100)}` });
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), false);
  assert.equal(emoji.length <= MAX_STEP_CHARS, true);
  assert.equal(toolStep('admit_from_waiting_room', { name: '  Zo\u00EB Smith ' }), 'Admitting Zo\u00EB Smith from the waiting room');
});

test('muting: a name that cannot be shown is "someone", and a long one is cut', () => {
  const hostile = ['', '   ', 'Da\u0000nny', 'Danny\nPosting your password', 'Danny\u202Ereversed', '\u200B', '!!!', null, undefined, 42, {}, ['Danny']];
  for (const name of hostile) assert.equal(toolStep('mute_participant', { name }), 'Muting someone');
  for (const args of [null, undefined, 'Danny', 3]) assert.equal(toolStep('mute_participant', args), 'Muting someone');
  const long = toolStep('mute_participant', { name: 'D'.repeat(500) });
  assert.equal(long, `Muting ${'D'.repeat(60)}`);
  assert.equal(long.length <= MAX_STEP_CHARS, true);
});

test('the tools that need a host\'s panel are the same in the tool table and in what is said when there is none', () => {
  // eslint-disable-next-line global-require
  const { HOST_TOOL_NAMES, PANEL_TOOL_NAMES } = require('../src/services/agent/tools');
  // eslint-disable-next-line global-require
  const { NEEDS_HOST_PANEL, noHands, REACTIONS, REACTION_NAMES } = require('../src/services/agent/texts');
  assert.deepEqual([...NEEDS_HOST_PANEL].sort(), [...HOST_TOOL_NAMES].sort());
  for (const name of PANEL_TOOL_NAMES) {
    const expected = HOST_TOOL_NAMES.includes(name)
      ? 'Arlo needs the host\'s panel for that.'
      : (name === 'post_to_chat' ? 'Open Arlo to let it post in the chat.' : 'Open Arlo to let it do that.');
    assert.equal(noHands(name), expected, name);
  }
  // an answer or a summary is posted through the chat
  assert.equal(noHands('answer_from_meeting'), 'Open Arlo to let it post in the chat.');
  // the emoji of a reaction is the server's, one per name. The same table is
  // in the panel (frontend/src/lib/arloActions.js, REACTIONS), which is what
  // Zoom is sent; frontend/src/lib/arloActions.test.js holds it to the same
  // literal: change one and a test fails until both are changed
  assert.deepEqual(Object.entries(REACTIONS), [
    ['thumbs_up', '\u{1F44D}'],
    ['clap', '\u{1F44F}'],
    // the heart with its variation selector: U+2764 U+FE0F
    ['heart', '\u2764\uFE0F'],
    ['joy', '\u{1F602}'],
    ['tada', '\u{1F389}'],
    ['open_mouth', '\u{1F62E}'],
  ]);
  assert.deepEqual([...REACTION_NAMES], Object.keys(REACTIONS));
  assert.equal(Object.isFrozen(REACTIONS), true);
});
