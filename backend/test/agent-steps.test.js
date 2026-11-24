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
