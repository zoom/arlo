// "Arlo, open the notes for everyone": the tool in the table, the policy
// (always the sheet), the sentences, and what a panel may report.
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
const { decide, typedRequestCovers } = require('../src/services/agent/policy');
const {
  TOOL_TEXTS, toolStep, noHands, failedReply, NOTES_NOT_OPENED,
} = require('../src/services/agent/texts');
const { readHandsAnnouncement, RESULT_CODES } = require('../src/services/agent/hands');

const NAME = 'open_notes_for_everyone';

test('open_notes_for_everyone is in every deployment\'s table: a panel\'s tool that changes the meeting, no host needed, no arguments', () => {
  assert.equal(toolNames().includes(NAME), true);
  const tool = getTool(NAME);
  assert.deepEqual([tool.runs, tool.changesMeeting, tool.needsHost === true], ['panel', true, false]);
  assert.equal(PANEL_TOOL_NAMES.includes(NAME), true);
  assert.equal(HOST_TOOL_NAMES.includes(NAME), false);
  assert.deepEqual(tool.parameters.properties, {});
  // the model is told what it is, and what it is not
  assert.match(tool.description, /shared document/i);
  assert.match(tool.description, /not for only (making|sharing)/i);
  assert.match(tool.description, /invitation/i);
  // the two it must not be mistaken for say so too
  assert.match(getTool('share_notes').description, /not for opening/i);
  assert.match(getTool('invite_everyone').description, /not for opening/i);

  assert.deepEqual(validateToolCall(NAME, {}), { ok: true, args: {} });
  for (const args of [{ shareScreen: false }, { everyone: true }, { url: 'https://example.test' }, null, [], 'all']) {
    assert.deepEqual(validateToolCall(NAME, args), { ok: false }, JSON.stringify(args));
  }
});

test('opening the notes for everyone: the sheet for speech and for someone who is not an owner, and never covered by what an owner typed', () => {
  for (const asker of ['owner', 'other']) {
    for (const whoCanAsk of ['owner', 'anyone']) {
      assert.equal(decide({ channel: 'voice', asker, whoCanAsk, toolKind: 'change', ownerPanelOpen: true }), 'sheet');
      assert.equal(decide({ channel: 'voice', asker, whoCanAsk, toolKind: 'change', ownerPanelOpen: false }), 'silent');
    }
  }
  assert.equal(decide({ channel: 'panel', asker: 'other', whoCanAsk: 'anyone', toolKind: 'change' }), 'sheet');
  assert.equal(decide({ channel: 'panel', asker: 'other', whoCanAsk: 'owner', toolKind: 'change' }), 'refuse');
  // an owner's typed request is a 'run' for the policy, and then never covered: the sheet
  for (const typed of [
    'open the notes for everyone', 'Arlo, open the notes for everyone please', 'OPEN THE NOTES FOR EVERYONE',
    'share the notes and open them for everyone', 'put the notes up', 'what did we decide?', '', 5, null,
  ]) {
    assert.equal(typedRequestCovers(typed, NAME, {}), false, String(typed));
  }
});

test('what the record, the sheet and the asker\'s panel say about opening the notes', () => {
  const texts = TOOL_TEXTS[NAME];
  assert.deepEqual(
    [texts.asked({}), texts.done({}), texts.question({}), texts.primary({}), texts.reply({})],
    [
      'Asked to open the notes for everyone',
      'Opened the notes for everyone',
      'Open the notes for everyone in the meeting? Your Arlo view will be shared, and the notes stay shared until you stop sharing.',
      'Open notes',
      'Done: opened the notes for everyone.',
    ],
  );
  assert.equal(toolStep(NAME, {}), 'Opening the notes for everyone');
  assert.equal(noHands(NAME), 'Open Arlo to let it do that.');
  assert.equal(NOTES_NOT_OPENED, 'Shared the notes. Couldn\'t open them for everyone.');
  // the half-done sentence is picked where the run ends (agent.js), not by code
  assert.equal(failedReply(NAME, 'sdk_error', {}), null);
  // nothing is sent in place of opening the notes: no sentence says an invitation went out
  assert.equal(require('../src/services/agent/texts').NOTES_OPENED_AS_INVITE, undefined);
});

test('a panel may announce the tool; there is no code for a fallback to an invitation', () => {
  assert.deepEqual(readHandsAnnouncement({ zoomRole: 'attendee', can: [NAME] }), { zoomRole: 'attendee', can: [NAME] });
  assert.equal(RESULT_CODES.includes('fell_back_invite'), false);
  // every panel tool at once still fits in one announcement
  assert.deepEqual(readHandsAnnouncement({ zoomRole: 'host', can: [...PANEL_TOOL_NAMES] }), { zoomRole: 'host', can: [...PANEL_TOOL_NAMES] });
});
