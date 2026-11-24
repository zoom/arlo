// "Arlo, set a five minute timer": the two tools in the table, the minutes a
// model gives, the policy for what an owner typed, and the sentences.
// Nothing here touches the network.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9' });
delete process.env.WEB_SEARCH_ENABLED;
delete process.env.JIRA_BASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toolNames, getTool, validateToolCall, PANEL_TOOL_NAMES, HOST_TOOL_NAMES,
} = require('../src/services/agent/tools');
const { decide, typedRequestCovers, minutesIn } = require('../src/services/agent/policy');
const {
  TOOL_TEXTS, toolStep, noHands,
} = require('../src/services/agent/texts');
const { readHandsAnnouncement } = require('../src/services/agent/hands');

test('set_timer and stop_timer are in every deployment\'s table: a panel\'s tools that change the meeting, no host needed', () => {
  for (const name of ['set_timer', 'stop_timer']) {
    assert.equal(toolNames().includes(name), true, name);
    const tool = getTool(name);
    assert.deepEqual([tool.runs, tool.changesMeeting, tool.needsHost === true], ['panel', true, false], name);
    assert.equal(PANEL_TOOL_NAMES.includes(name), true);
    assert.equal(HOST_TOOL_NAMES.includes(name), false);
    assert.match(tool.description, /everyone/i);
  }
  assert.deepEqual(getTool('set_timer').parameters.properties.minutes.type, 'integer');
  assert.deepEqual([getTool('set_timer').parameters.properties.minutes.minimum, getTool('set_timer').parameters.properties.minutes.maximum], [1, 120]);
  assert.deepEqual(getTool('set_timer').parameters.required, ['minutes']);
  assert.deepEqual(getTool('stop_timer').parameters.properties, {});
});

test('a call of set_timer: whole minutes from 1 to 120, and nothing else is taken', () => {
  for (const minutes of [1, 5, 45, 120]) {
    assert.deepEqual(validateToolCall('set_timer', { minutes }), { ok: true, args: { minutes } });
  }
  // digits a model wrote as text are the same number, rebuilt as one
  assert.deepEqual(validateToolCall('set_timer', { minutes: '5' }), { ok: true, args: { minutes: 5 } });
  assert.deepEqual(validateToolCall('set_timer', { minutes: '120' }), { ok: true, args: { minutes: 120 } });
  for (const minutes of [
    0, -5, 121, 5.5, 1e3, NaN, Infinity, '5.5', 'five', '', ' 5', '5 ', '05', '0', '121', '1e1', '+5', '-5', '5 minutes', '٥',
    true, null, undefined, [5], { value: 5 },
  ]) {
    assert.deepEqual(validateToolCall('set_timer', { minutes }), { ok: false }, JSON.stringify(minutes) ?? String(minutes));
  }
  for (const args of [{}, { minutes: 5, sound: true }, { seconds: 300 }, { minutes: 5, text: 'Buy now' }, null, [5]]) {
    assert.deepEqual(validateToolCall('set_timer', args), { ok: false }, JSON.stringify(args));
  }
  assert.deepEqual(validateToolCall('stop_timer', {}), { ok: true, args: {} });
  for (const args of [{ minutes: 5 }, { all: true }, null, []]) assert.deepEqual(validateToolCall('stop_timer', args), { ok: false });
});

test('a timer changes the meeting: a sheet for everything spoken, and for someone who is not an owner', () => {
  for (const asker of ['owner', 'other']) {
    assert.equal(decide({ channel: 'voice', asker, whoCanAsk: 'anyone', toolKind: 'change', ownerPanelOpen: true }), 'sheet');
  }
  assert.equal(decide({ channel: 'panel', asker: 'other', whoCanAsk: 'anyone', toolKind: 'change' }), 'sheet');
});

test('the minutes in what someone typed: digits or a number word, with the word "minute"; an hour and half an hour', () => {
  const read = [
    ['set a 5 minute timer', [5]],
    ['start a 10 minute timer', [10]],
    ['timer for 10 minutes', [10]],
    ['a 10-minute timer', [10]],
    ['15 min timer', [15]],
    ['20 mins on the timer', [20]],
    ['set a five minute timer', [5]],
    ['timer for one minute', [1]],
    ['a twenty minute timer', [20]],
    ['nineteen minutes', [19]],
    ['a forty-five minute timer', [45]],
    ['forty five minutes', [45]],
    ['thirty minutes', [30]],
    ['sixty minutes', [60]],
    ['ninety minutes', [90]],
    ['set a timer for an hour', [60]],
    ['set a timer for half an hour', [30]],
    ['a 5 minute timer and then a 10 minute timer', [5, 10]],
    // not read as an amount at all
    ['set a timer', []],
    ['set a timer for 5', []],
  ];
  for (const [text, minutes] of read) assert.deepEqual(minutesIn(text), minutes, text);
  // an amount that cannot be read for sure is there, and equals no number
  for (const text of [
    'twenty five minutes', 'twenty-five minute timer', 'a hundred and five minutes', '1.5 minutes', '1,5 minutes', '2 hours',
    'one hour', 'an hour and a half', '90 seconds', 'thirty second timer', '5 minutes and 30 seconds', '2.5 hour timer',
    'set a timer for a minute', 'minute five of the timer', 'a few minutes',
  ]) {
    const got = minutesIn(text);
    assert.equal(got.length > 0 && got.some((one) => Number.isNaN(one)), true, text);
  }
});

test('an owner\'s typed timer runs without a sheet only when the word and exactly those minutes are in what they typed', () => {
  const covers = (typed, minutes) => typedRequestCovers(typed, 'set_timer', { minutes });
  for (const [typed, minutes] of [
    ['set a five minute timer', 5],
    ['Arlo, start a 10 minute timer please', 10],
    ['Timer for 45 minutes', 45],
    ['ｓｅｔ a 5 minute ｔｉｍｅｒ', 5],
    ['set a timer for an hour', 60],
    ['half an hour timer', 30],
    ['set a 1 minute timer', 1],
    ['set a 120 minute timer', 120],
  ]) assert.equal(covers(typed, minutes), true, typed);

  for (const [typed, minutes] of [
    ['set a five minute timer', 10], // another number
    ['set a 5 minute timer', 50],
    ['set a 15 minute timer', 5],
    ['set a 15 minute timer', 1],
    ['give us five minutes', 5], // no "timer"
    ['five minutes on the timers', 5],
    ['set a timer', 5], // no minutes
    ['set a timer for 5', 5],
    ['set a 5 hour timer', 5],
    ['set a 2 hour timer', 120],
    ['set a 30 second timer', 30],
    ['don\'t set a 5 minute timer', 5], // turned around
    ['no 5 minute timer', 5],
    ['stop the timer and set a 5 minute timer', 5],
    ['set a 5 minute timer, or a 10 minute timer', 5], // two amounts
    ['set a twenty five minute timer', 5],
    ['set a 1.5 minute timer', 5],
    ['set a half an hour timer', 60],
    ['set a 5 minute timer', '5'], // not what the tool table gives
    ['set a 5 minute timer', 5.5],
    ['set a 0 minute timer', 0],
    ['set a 500 minute timer', 500],
    ['set a 5 minute timer', undefined],
  ]) assert.equal(covers(typed, minutes), false, `${typed} / ${minutes}`);
});

test('an owner\'s typed "stop the timer": "stop", "cancel" or "end" and "timer", each a word of its own', () => {
  const covers = (typed) => typedRequestCovers(typed, 'stop_timer', {});
  for (const typed of ['stop the timer', 'Cancel the timer please', 'Arlo, end the timer', 'timer: stop']) assert.equal(covers(typed), true, typed);
  for (const typed of [
    'the timer', 'stop', 'pause the timer', 'unstop the timer', 'stop the timers', 'stopwatch timer', 'the timer ended',
    'don\'t stop the timer', 'do not cancel the timer', 'never end the timer', 'what did we decide?',
  ]) assert.equal(covers(typed), false, typed);
  assert.equal(typedRequestCovers('stop the timer', 'stop_timer', null), false);
});

test('what the record, the sheet and the asker\'s panel say about a timer', () => {
  const set = TOOL_TEXTS.set_timer;
  const five = { minutes: 5 };
  assert.deepEqual(
    [set.asked(five), set.done(five), set.question(five), set.primary(five), set.reply(five)],
    ['Asked to start a 5 minute timer', 'Started a 5 minute timer', 'Start a 5 minute timer for everyone?', 'Start timer', 'Done: started a 5 minute timer.'],
  );
  assert.equal(set.question({ minutes: 1 }), 'Start a 1 minute timer for everyone?');
  // minutes that are not the tool table's are in no sentence
  for (const args of [null, {}, { minutes: '5' }, { minutes: 5.5 }, { minutes: 0 }, { minutes: 999 }, { minutes: 'Buy now' }]) {
    assert.equal(set.question(args), 'Start a timer for everyone?', JSON.stringify(args));
    assert.equal(set.asked(args), 'Asked to start a timer');
  }
  const stop = TOOL_TEXTS.stop_timer;
  assert.deepEqual(
    [stop.asked({}), stop.done({}), stop.question({}), stop.primary({}), stop.reply({})],
    ['Asked to stop the timer', 'Stopped the timer', 'Stop the timer?', 'Stop timer', 'Done: stopped the timer.'],
  );
  assert.equal(toolStep('set_timer', five), 'Starting a 5 minute timer');
  assert.equal(toolStep('set_timer', { minutes: 'x' }), 'Starting a timer');
  assert.equal(toolStep('stop_timer', {}), 'Stopping the timer');
  assert.equal(noHands('set_timer'), 'Open Arlo to let it do that.');
  assert.equal(noHands('stop_timer'), 'Open Arlo to let it do that.');
});

test('a host\'s panel can announce every panel tool there is at once', () => {
  // nine today; the server takes ten names
  assert.equal(PANEL_TOOL_NAMES.length, 9);
  assert.deepEqual(readHandsAnnouncement({ zoomRole: 'host', can: [...PANEL_TOOL_NAMES] }), { zoomRole: 'host', can: [...PANEL_TOOL_NAMES] });
});
