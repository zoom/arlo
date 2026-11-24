// Hearing "Arlo, …" in the stored transcript. A pure module: the clock and the
// timers are the test's own, fired by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommandDetector } = require('../src/services/agent/commandDetector');

const M = 'MEETING-DETECTOR==';

function setup(options = {}) {
  const clock = { now: 1_000_000 };
  const timers = [];
  const schedule = (fn, ms) => {
    const timer = { fn, ms, at: clock.now + ms, cancelled: false, fired: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  /** Move the clock and fire what is due, as a real timer would. */
  const advance = (ms) => {
    clock.now += ms;
    for (const timer of pending().filter((t) => t.at <= clock.now).sort((a, b) => a.at - b.at)) {
      if (timer.cancelled) continue;
      timer.fired = true;
      timer.fn();
    }
  };
  const heard = [];
  const detector = createCommandDetector({
    now: () => clock.now, schedule, onRequest: (meetingId, request) => heard.push({ meetingId, ...request }), ...options,
  });
  const say = (text, speakerId = '7', speakerLabel = 'Priya', meetingId = M) => detector.lineStored(meetingId, {
    speakerId, speakerLabel, text, tStartMs: clock.now,
  });
  const texts = () => heard.map((one) => one.text);
  return {
    detector, say, heard, texts, advance, pending, clock,
  };
}

test('a request in one line that ends its sentence is heard at once', () => {
  const { say, heard, pending } = setup();
  say('Arlo, what did we decide about the launch?');
  assert.deepEqual(heard, [{
    meetingId: M, text: 'what did we decide about the launch?', speakerId: '7', speakerLabel: 'Priya', at: 1_000_000,
  }]);
  assert.equal(pending().length, 0);
});

test('a request without a sentence end is heard once the speaker is quiet', () => {
  const { say, texts, advance, pending } = setup();
  say('Arlo summarize the meeting');
  assert.deepEqual(texts(), []);
  advance(1799);
  assert.deepEqual(texts(), []);
  advance(1);
  assert.deepEqual(texts(), ['summarize the meeting']);
  advance(60_000);
  assert.deepEqual(texts(), ['summarize the meeting']);
  assert.equal(pending().length, 0);
});

test('a request split across three lines by the same speaker is one request', () => {
  const { say, heard, advance } = setup();
  say('Arlo, what did');
  advance(1000);
  say('we decide about');
  advance(1000);
  say('the launch date');
  advance(1000);
  assert.equal(heard.length, 0); // still talking: each line starts the quiet time again
  advance(800);
  assert.deepEqual(heard.map((one) => [one.text, one.at]), [['what did we decide about the launch date', 1_000_000]]);
});

test('a sentence end closes a request only when it has three words or more', () => {
  const { say, texts, advance } = setup();
  say('Arlo, wait.');
  assert.deepEqual(texts(), []);
  say('Share the notes in chat. And then we go on.');
  assert.deepEqual(texts(), ['wait. Share the notes in chat.']);
  advance(60_000);
  assert.deepEqual(texts(), ['wait. Share the notes in chat.']);

  const short = setup();
  short.say('Arlo, summarize.');
  assert.deepEqual(short.texts(), []);
  short.advance(1800);
  assert.deepEqual(short.texts(), ['summarize.']);
});

test('another speaker talking closes the request, and their line is not part of it', () => {
  const { say, heard, advance } = setup();
  say('Arlo, let Tomasz');
  say('sorry, one second', '9', 'Keiko');
  assert.deepEqual(heard.map((one) => [one.text, one.speakerId]), [['let Tomasz', '7']]);
  say('in from the waiting room');
  advance(60_000);
  assert.equal(heard.length, 1);
});

test('the other speaker\'s own request is heard too', () => {
  const { say, heard } = setup();
  say('Arlo, share the');
  say('Arlo, summarize the meeting so far.', '9', 'Keiko');
  assert.deepEqual(heard.map((one) => [one.text, one.speakerLabel]), [['share the', 'Priya'], ['summarize the meeting so far.', 'Keiko']]);
});

test('without a speaker id the label says who is talking', () => {
  for (const noId of [null, '', '  ', 'unknown', 5]) {
    const { say, heard, advance } = setup();
    say('Arlo, what did', noId, 'Priya');
    say('we decide', noId, 'Priya');
    assert.equal(heard.length, 0, JSON.stringify(noId));
    say('hold on', noId, 'Keiko');
    assert.deepEqual(heard.map((one) => [one.text, one.speakerId, one.speakerLabel]), [['what did we decide', null, 'Priya']]);
    advance(60_000);
  }
  // the id wins over the label: two people with one name are two speakers
  const { say, texts } = setup();
  say('Arlo, what did', '7', 'Priya');
  say('we decide', '8', 'Priya');
  assert.deepEqual(texts(), ['what did']);
});

test('"Arlo" in the middle of a sentence is not a request', () => {
  const { say, heard, advance, pending } = setup();
  for (const line of [
    'I asked Arlo yesterday to summarize the meeting.',
    'So Arlo, what did we decide?',
    'Okay, Arlo, share the notes.',
    'We should let arlo handle the notes',
    'Is that Carlo, the new designer?',
    'Marlo, share the notes please.',
  ]) say(line);
  advance(60_000);
  assert.deepEqual(heard, []);
  assert.equal(pending().length, 0);
});

test('"Arlo\'s", "Arlo is", "Arlo was" and the name alone open nothing', () => {
  const { say, heard, advance, pending } = setup();
  for (const line of [
    'Arlo\'s notes were good last time.',
    'Arlo is taking notes for us today.',
    'Arlo was really useful in the last review.',
    'Arlo isn\'t in this meeting, is it?',
    'Arlo',
    'Arlo.',
    'Arlo,',
    'Hey Arlo!',
    '   arlo   ',
    'Arlow, share the notes please.',
  ]) say(line);
  advance(60_000);
  assert.deepEqual(heard, []);
  assert.equal(pending().length, 0);
  // with a comma it is addressed to Arlo
  say('Arlo, is the budget approved yet?');
  assert.deepEqual(heard.map((one) => one.text), ['is the budget approved yet?']);
});

test('"Hey Arlo, …" and other ways of writing the name', () => {
  for (const [line, text] of [
    ['Hey Arlo, summarize the meeting so far.', 'summarize the meeting so far.'],
    ['hey arlo share the notes please.', 'share the notes please.'],
    ['  ARLO: admit Tomasz from the waiting room.', 'admit Tomasz from the waiting room.'],
    ['Arlo! What did we decide?', 'What did we decide?'],
    ['Arlo. Summarize the meeting so far.', 'Summarize the meeting so far.'],
    ['Hey, Arlo, what did we decide?', 'what did we decide?'],
  ]) {
    const { say, texts } = setup();
    say(line);
    assert.deepEqual(texts(), [text], line);
  }
});

test('a request can start after a sentence end inside a line', () => {
  const { say, texts } = setup();
  say('That is all from me. Arlo, share the notes in chat.');
  say('Good question! Hey Arlo, what did we decide about pricing?');
  assert.deepEqual(texts(), ['share the notes in chat.', 'what did we decide about pricing?']);
});

test('two requests in one line are two requests', () => {
  const { say, texts, advance } = setup();
  say('Arlo, summarize the meeting so far. Arlo, share the notes in chat.');
  assert.deepEqual(texts(), ['summarize the meeting so far.', 'share the notes in chat.']);
  // the second one opening closes a first that had not ended
  const open = setup();
  open.say('Arlo, wait. Arlo, share the notes');
  assert.deepEqual(open.texts(), ['wait.']);
  open.advance(1800);
  assert.deepEqual(open.texts(), ['wait.', 'share the notes']);
  advance(60_000);
  assert.equal(texts().length, 2);
});

test('a speaker who keeps talking is cut off after 12 seconds', () => {
  const { say, heard, advance } = setup();
  say('Arlo, tell me');
  for (let i = 0; i < 11; i += 1) {
    advance(1000);
    say('and also');
  }
  assert.equal(heard.length, 0);
  advance(1000);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].text, `tell me${' and also'.repeat(11)}`);
  say('and more');
  advance(60_000);
  assert.equal(heard.length, 1);
});

test('a request is at most 400 characters', () => {
  const { say, heard, pending } = setup();
  say(`Arlo, ${'word '.repeat(200)}`);
  assert.equal(heard.length, 1);
  assert.ok(heard[0].text.length <= 400 && heard[0].text.length >= 395);
  assert.match(heard[0].text, /^(word ?)+$/);
  assert.equal(pending().length, 0);

  const across = setup({ maxChars: 20 });
  across.say('Arlo, one two');
  across.say('three four five six seven');
  assert.deepEqual(across.texts(), ['one two three four f']);
});

test('the limits can be set, and a bad one falls back to the default', () => {
  const quick = setup({ settleMs: 100, maxMs: 300 });
  quick.say('Arlo, share the notes');
  quick.advance(100);
  assert.deepEqual(quick.texts(), ['share the notes']);
  quick.say('Arlo, keep');
  for (let i = 0; i < 5; i += 1) { quick.advance(60); quick.say('going'); }
  // 300 ms after it opened, in the middle of the speaker's fifth line
  assert.deepEqual(quick.texts(), ['share the notes', 'keep going going going going']);

  for (const bad of [0, -5, NaN, Infinity, '100', null]) {
    const fallback = setup({ settleMs: bad, maxMs: bad, maxChars: bad });
    fallback.say('Arlo, share the notes');
    fallback.advance(1799);
    assert.deepEqual(fallback.texts(), [], String(bad));
    fallback.advance(1);
    assert.deepEqual(fallback.texts(), ['share the notes'], String(bad));
  }
});

test('the same speaker repeating the same request within 10 seconds is heard once', () => {
  const { say, texts, advance } = setup();
  say('Arlo, summarize the meeting so far.');
  advance(3000);
  say('ARLO,  summarize the meeting so far!');
  advance(3000);
  say('Hey Arlo, summarize the meeting, so far');
  advance(1800);
  assert.deepEqual(texts(), ['summarize the meeting so far.']);
  // someone else asking the same is another request
  say('Arlo, summarize the meeting so far.', '9', 'Keiko');
  assert.equal(texts().length, 2);
  // a different request by the same speaker too
  say('Arlo, share the notes in chat.');
  assert.equal(texts().length, 3);
  // and after 10 seconds the same one again
  advance(10_001);
  say('Arlo, summarize the meeting so far.');
  assert.equal(texts().length, 4);
});

test('forget drops what is open and what was heard, for that meeting only', () => {
  const { detector, say, heard, advance, pending } = setup();
  say('Arlo, share the notes');
  say('Arlo, summarize the meeting', '7', 'Priya', 'OTHER==');
  detector.forget(M);
  assert.equal(pending().length, 2); // the other meeting's quiet time and its 12 seconds
  advance(60_000);
  assert.deepEqual(heard.map((one) => [one.meetingId, one.text]), [['OTHER==', 'summarize the meeting']]);
  assert.equal(pending().length, 0);

  // the next meeting under the same id starts clean: no leftover text, no "repeat"
  say('Arlo, share the notes in chat.');
  detector.forget(M);
  say('Arlo, share the notes in chat.');
  assert.equal(heard.length, 3);
  for (const bad of [null, undefined, 5, 'never-seen']) detector.forget(bad);
});

test('meetings do not mix', () => {
  const { say, heard, advance } = setup();
  say('Arlo, what did', '7', 'Priya', 'A==');
  say('Arlo, share the', '7', 'Priya', 'B==');
  say('we decide', '7', 'Priya', 'A==');
  say('notes please', '7', 'Priya', 'B==');
  advance(1800);
  assert.deepEqual(heard.map((one) => [one.meetingId, one.text]), [['A==', 'what did we decide'], ['B==', 'share the notes please']]);
});

test('state is bounded: with too many meetings the one heard from longest ago is dropped', () => {
  const { say, heard, advance, pending, detector } = setup({ maxMeetings: 2 });
  say('Arlo, one one one', '7', 'Priya', 'A==');
  say('Arlo, two two two', '7', 'Priya', 'B==');
  say('Arlo, three three three', '7', 'Priya', 'C==');
  assert.equal(detector.tracked(), 2);
  assert.equal(pending().length, 4);
  advance(1800);
  assert.deepEqual(heard.map((one) => one.meetingId), ['B==', 'C==']);
  assert.equal(detector.tracked(), 2);
});

test('what is not a line is ignored, and nothing is ever thrown', () => {
  const { detector, heard, advance, pending } = setup();
  for (const line of [null, undefined, 'Arlo, share the notes.', 5, [], {}, { text: 5 }, { text: '' }, { text: null, speakerId: '7' }]) {
    detector.lineStored(M, line);
  }
  for (const meetingId of [null, undefined, 5, '', {}]) detector.lineStored(meetingId, { text: 'Arlo, share the notes.', speakerId: '7' });
  advance(60_000);
  assert.deepEqual(heard, []);
  assert.equal(pending().length, 0);
  // no speaker at all is still one speaker
  detector.lineStored(M, { text: 'Arlo, share the notes in chat.' });
  assert.deepEqual(heard.map((one) => [one.text, one.speakerId, one.speakerLabel]), [['share the notes in chat.', null, null]]);
});

test('a line far too long is read only as far as a line goes, and names are bounded', () => {
  const { detector, heard } = setup();
  detector.lineStored(M, { text: `${'filler '.repeat(2000)}. Arlo, share the notes in chat.`, speakerId: 'i'.repeat(500), speakerLabel: 'n'.repeat(500) });
  assert.equal(heard.length, 0); // past the 4000 characters a stored line has
  detector.lineStored(M, { text: 'Arlo, share the notes in chat.', speakerId: 'i'.repeat(500), speakerLabel: 'n'.repeat(500) });
  assert.deepEqual([heard[0].speakerId.length, heard[0].speakerLabel.length], [200, 200]);
});

test('a handler that throws does not break hearing', () => {
  let count = 0;
  const { say } = setup({ onRequest: () => { count += 1; throw new Error('handler failed'); } });
  say('Arlo, share the notes in chat.');
  say('Arlo, summarize the meeting so far.');
  assert.equal(count, 2);
});

test('the detector needs a handler', () => {
  assert.throws(() => createCommandDetector({}), /onRequest/);
  assert.throws(() => createCommandDetector(), /onRequest/);
});

test('nothing is logged', () => {
  const seen = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const level of Object.keys(real)) console[level] = (...args) => seen.push(args.join(' '));
  try {
    const { say, advance } = setup({ onRequest: () => { throw new Error('handler failed'); } });
    say('Arlo, share the notes in chat.');
    say('Arlo, let Tomasz');
    advance(60_000);
  } finally {
    Object.assign(console, real);
  }
  assert.deepEqual(seen, []);
});
