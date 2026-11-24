// Who gets what from Arlo: the policy as a table, and how a transcript
// speaker is (or is not) taken to be an owner.
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, panelMayAsk } = require('../src/services/agent/policy');
const { createSpeakerMatch, readSpeakerMatchMode, SPEAKER_MATCH_MODES } = require('../src/services/agent/speakerMatch');
const { createMemoryMeetingStore } = require('../src/storage/memoryMeetingStore');

// channel, asker, whoCanAsk, toolKind -> outcome. Every combination is here.
// asker 'owner': typed by an owner in their panel, or spoken by a speaker
// verified to be an owner. 'other': anyone else.
const TABLE = [
  ['panel', 'owner', 'owner', 'read', 'run'],
  ['panel', 'owner', 'owner', 'change', 'run'],
  ['panel', 'owner', 'owner', 'none', 'refuse'],
  ['panel', 'owner', 'anyone', 'read', 'run'],
  ['panel', 'owner', 'anyone', 'change', 'run'],
  ['panel', 'owner', 'anyone', 'none', 'refuse'],
  ['panel', 'other', 'owner', 'read', 'refuse'],
  ['panel', 'other', 'owner', 'change', 'refuse'],
  ['panel', 'other', 'owner', 'none', 'refuse'],
  ['panel', 'other', 'anyone', 'read', 'run'],
  ['panel', 'other', 'anyone', 'change', 'sheet'],
  ['panel', 'other', 'anyone', 'none', 'refuse'],
  ['voice', 'owner', 'owner', 'read', 'run'],
  ['voice', 'owner', 'owner', 'change', 'run'],
  ['voice', 'owner', 'owner', 'none', 'silent'],
  ['voice', 'owner', 'anyone', 'read', 'run'],
  ['voice', 'owner', 'anyone', 'change', 'run'],
  ['voice', 'owner', 'anyone', 'none', 'silent'],
  ['voice', 'other', 'owner', 'read', 'sheet'],
  ['voice', 'other', 'owner', 'change', 'sheet'],
  ['voice', 'other', 'owner', 'none', 'silent'],
  ['voice', 'other', 'anyone', 'read', 'run'],
  ['voice', 'other', 'anyone', 'change', 'sheet'],
  ['voice', 'other', 'anyone', 'none', 'silent'],
];

test('the policy, every combination', () => {
  assert.equal(TABLE.length, 2 * 2 * 2 * 3);
  assert.equal(new Set(TABLE.map((row) => row.slice(0, 4).join())).size, TABLE.length);
  for (const [channel, asker, whoCanAsk, toolKind, outcome] of TABLE) {
    assert.equal(decide({ channel, asker, whoCanAsk, toolKind }), outcome, `${channel} ${asker} ${whoCanAsk} ${toolKind}`);
  }
});

test('anything the policy does not know is refused (typed) or silent (spoken), never run', () => {
  const good = { channel: 'panel', asker: 'owner', whoCanAsk: 'anyone', toolKind: 'change' };
  for (const bad of [
    { channel: 'chat' }, { channel: undefined }, { asker: 'host' }, { asker: true }, { asker: undefined },
    { whoCanAsk: 'everyone' }, { whoCanAsk: undefined }, { toolKind: 'write' }, { toolKind: undefined },
  ]) {
    assert.equal(decide({ ...good, ...bad }), 'refuse', JSON.stringify(bad));
  }
  assert.equal(decide({ ...good, channel: 'voice', asker: 'verified' }), 'silent');
  assert.equal(decide({ ...good, channel: 'voice', toolKind: 'anything' }), 'silent');
  // an unknown setting is the stricter one
  assert.equal(decide({ channel: 'voice', asker: 'other', whoCanAsk: 'everyone', toolKind: 'read' }), 'sheet');
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
