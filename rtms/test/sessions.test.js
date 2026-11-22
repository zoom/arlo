// The RTMS session lifecycle, driven through a fake Zoom RTMS client. The real
// client is a native module that only runs in the Linux container.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionManager } = require('../src/sessions');

class FakeClient {
  constructor() { this.handlers = {}; this.joined = null; this.left = 0; }
  onTranscriptData(cb) { this.handlers.transcript = cb; }
  onJoinConfirm(cb) { this.handlers.joinConfirm = cb; }
  onLeave(cb) { this.handlers.leave = cb; }
  onSessionUpdate(cb) { this.handlers.sessionUpdate = cb; }
  onMediaConnectionInterrupted(cb) { this.handlers.mediaInterrupted = cb; }
  onParticipantEvent(cb) { this.handlers.participant = cb; }
  join(options) { this.joined = options; return true; }
  leave() { this.left += 1; }
}

function setup({ clientFactory } = {}) {
  const clients = [];
  const sent = { status: [], segments: [], participantEvents: [] };
  const clock = { now: 1_000_000 };
  const manager = createSessionManager({
    createClient: clientFactory || (() => { const c = new FakeClient(); clients.push(c); return c; }),
    backend: {
      status: async (meetingId, status, operatorId) => { sent.status.push({ meetingId, status, operatorId }); },
      segment: async (meetingId, segment) => { sent.segments.push({ meetingId, segment }); },
      participantEvents: async (meetingId, events) => { sent.participantEvents.push({ meetingId, events }); },
    },
    now: () => clock.now,
    defer: (fn) => fn(),
    log: { log() {}, warn() {}, error() {} },
  });
  return { manager, clients, sent, clock };
}

const started = (overrides = {}) => ({
  meeting_uuid: 'MEETING-1==', rtms_stream_id: 'stream-1', server_urls: 'wss://zoom.example', operator_id: 'op-1', ...overrides,
});
const statuses = (sent) => sent.status.map((s) => s.status);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a stream is reported as started only after Zoom confirms the join', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  assert.deepEqual(clients[0].joined, { meeting_uuid: 'MEETING-1==', rtms_stream_id: 'stream-1', server_urls: 'wss://zoom.example' });
  assert.deepEqual(statuses(sent), []);

  clients[0].handlers.joinConfirm(0);
  await tick();
  assert.deepEqual(sent.status, [{ meetingId: 'MEETING-1==', status: 'rtms_started', operatorId: 'op-1' }]);
  assert.equal(manager.size(), 1);
});

test('a refused join (status 16) is reported as failed and the client is released', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  clients[0].handlers.joinConfirm(16);
  await tick();

  assert.deepEqual(statuses(sent), ['rtms_failed']);
  assert.equal(clients[0].left, 1);
  assert.equal(manager.size(), 0);

  // the same stream can be started again afterwards
  await manager.started(started());
  assert.equal(clients.length, 2);
});

test('a join that throws is reported as failed and leaves no session behind', async () => {
  const { manager, sent } = setup({
    clientFactory: () => Object.assign(new FakeClient(), { join() { throw new Error('native failure'); } }),
  });
  await manager.started(started());
  assert.deepEqual(statuses(sent), ['rtms_failed']);
  assert.equal(manager.size(), 0);
});

test('a repeated webhook for a stream that is already connected is ignored', async () => {
  const { manager, clients } = setup();
  await manager.started(started());
  await manager.started(started());
  assert.equal(clients.length, 1);
});

test('a new stream id for the same meeting replaces the old stream', async () => {
  const { manager, clients } = setup();
  await manager.started(started());
  await manager.started(started({ rtms_stream_id: 'stream-2' }));
  assert.equal(clients[0].left, 1);
  assert.equal(clients[1].joined.rtms_stream_id, 'stream-2');
  assert.equal(manager.size(), 1);
});

test('webhooks without a meeting or stream id are ignored', async () => {
  const { manager, clients, sent } = setup();
  await manager.started({ meeting_uuid: 'MEETING-1==' });
  await manager.started({ rtms_stream_id: 'stream-1' });
  await manager.started({ meeting_uuid: 42, rtms_stream_id: 'stream-1' });
  await manager.started(null);
  assert.equal(clients.length, 0);
  assert.deepEqual(statuses(sent), []);
});

test('transcript data is forwarded as numbered segments with the speaker and a millisecond timestamp', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  const { transcript } = clients[0].handlers;
  transcript(Buffer.from('We ship on Friday.'), 18, 1_700_000_000_123_456, { userId: 7, userName: 'Ana' });
  transcript(Buffer.from('Agreed.'), 7, 1_700_000_001_000_000, { userId: 8 });
  transcript(Buffer.from('Who is this?'), 12, undefined, undefined);
  await tick();

  assert.deepEqual(sent.segments.map((s) => s.segment.seqNo), [1, 2, 3]);
  assert.deepEqual(sent.segments[0], {
    meetingId: 'MEETING-1==',
    segment: { speakerId: '7', speakerLabel: 'Ana', text: 'We ship on Friday.', tStartMs: 1_700_000_000_123, tEndMs: 1_700_000_000_123, seqNo: 1 },
  });
  assert.equal(sent.segments[1].segment.speakerLabel, 'Speaker 8');
  assert.equal(sent.segments[2].segment.speakerLabel, 'Speaker');
  assert.equal(sent.segments[2].segment.speakerId, 'unknown');
});

test('a stop webhook leaves the stream and reports stopped, found by stream id or by meeting', async () => {
  for (const payload of [{ meeting_uuid: 'MEETING-1==', rtms_stream_id: 'stream-1' }, { meeting_uuid: 'MEETING-1==' }]) {
    const { manager, clients, sent } = setup();
    await manager.started(started());
    await manager.stopped(payload);
    assert.equal(clients[0].left, 1);
    assert.equal(manager.size(), 0);
    assert.deepEqual(statuses(sent), ['rtms_stopped']);
  }
});

test('a stop for a stream this service does not hold is still reported', async () => {
  const { manager, sent } = setup();
  await manager.stopped({ meeting_uuid: 'MEETING-1==' });
  assert.deepEqual(statuses(sent), ['rtms_stopped']);
});

test('when Zoom closes the connection the session is dropped and reported, without waiting for a webhook', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  clients[0].handlers.joinConfirm(0);
  clients[0].handlers.leave(3);
  await tick();

  assert.equal(manager.size(), 0);
  assert.deepEqual(statuses(sent), ['rtms_started', 'rtms_stopped']);
  assert.equal(clients[0].left, 0); // already closed by Zoom: nothing to leave
});

test('leaving on our own stop is not reported twice', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  clients[0].leave = function leave() { this.left += 1; this.handlers.leave(0); }; // the SDK fires onLeave from leave()
  await manager.stopped({ meeting_uuid: 'MEETING-1==' });
  await tick();
  assert.deepEqual(statuses(sent), ['rtms_stopped']);
});

test('people already in the meeting are a roster, later arrivals are joins', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  const { participant, transcript } = clients[0].handlers;

  participant('join', 1, [{ participantId: 11, userName: 'Ana' }]);
  transcript(Buffer.from('Hello'), 5, 1_700_000_000_000_000, { userId: 11, userName: 'Ana' });
  participant('join', 2, [{ participantId: 12, userName: 'Ben' }]);
  participant('leave', 3, [{ participantId: 12 }]);
  await tick();

  const events = sent.participantEvents.flatMap((p) => p.events).map((e) => [e.eventType, e.participantName]);
  assert.deepEqual(events, [['initial_roster', 'Ana'], ['joined', 'Ben'], ['left', 'Ben']]);
});

test('leave events fired by the SDK while a stream is being stopped are not shown as people leaving', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  const client = clients[0];
  client.leave = function leave() { this.left += 1; this.handlers.participant('leave', 9, [{ participantId: 11 }]); };
  await manager.stopped({ meeting_uuid: 'MEETING-1==' });
  await tick();
  assert.equal(sent.participantEvents.length, 0);
});

test('a media interruption is reported and the session is kept', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  clients[0].handlers.mediaInterrupted(123);
  await tick();
  assert.deepEqual(statuses(sent), ['media_interrupted']);
  assert.equal(manager.size(), 1);
});

test('sessions older than 24 hours are swept', async () => {
  const { manager, clients, clock } = setup();
  await manager.started(started());
  clock.now += 23 * 60 * 60 * 1000;
  assert.equal(manager.sweep(), 0);
  clock.now += 2 * 60 * 60 * 1000;
  assert.equal(manager.sweep(), 1);
  assert.equal(clients[0].left, 1);
  assert.equal(manager.size(), 0);
});

test('shutdown leaves every stream', async () => {
  const { manager, clients } = setup();
  await manager.started(started());
  await manager.started(started({ meeting_uuid: 'MEETING-2==', rtms_stream_id: 'stream-9' }));
  manager.closeAll();
  assert.deepEqual(clients.map((c) => c.left), [1, 1]);
  assert.equal(manager.size(), 0);
});

test('a backend that cannot be reached does not break the stream', async () => {
  const clients = [];
  const manager = createSessionManager({
    createClient: () => { const c = new FakeClient(); clients.push(c); return c; },
    backend: {
      status: async () => { throw new Error('ECONNREFUSED'); },
      segment: async () => { throw new Error('ECONNREFUSED'); },
      participantEvents: async () => { throw new Error('ECONNREFUSED'); },
    },
    defer: (fn) => fn(),
    log: { log() {}, warn() {}, error() {} },
  });
  await manager.started(started());
  clients[0].handlers.joinConfirm(0);
  clients[0].handlers.transcript(Buffer.from('still here'), 10, 1, { userId: 1 });
  await tick();
  assert.equal(manager.size(), 1);
});

test('what people say and who they are never reaches the logs, at any log level', async () => {
  const lines = [];
  const record = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  const clients = [];
  const manager = createSessionManager({
    createClient: () => { const c = new FakeClient(); clients.push(c); return c; },
    backend: { status: async () => {}, segment: async () => {}, participantEvents: async () => {} },
    defer: (fn) => fn(),
    log: { log: record, warn: record, error: record },
    logPii: true, // an old option must not bring transcript logging back
  });
  await manager.started(started());
  clients[0].handlers.joinConfirm(0);
  clients[0].handlers.participant('join', 1, [{ participantId: 11, userName: 'Ana Ruiz' }]);
  clients[0].handlers.transcript(Buffer.from('My diagnosis is confidential'), 28, 1_700_000_000_000_000, { userId: 11, userName: 'Ana Ruiz' });
  await manager.stopped({ meeting_uuid: 'MEETING-1==' });
  await tick();

  const output = lines.join('\n');
  for (const secret of ['My diagnosis', 'confidential', 'Ana Ruiz', 'MEETING-1==', 'stream-1', 'op-1']) {
    assert.equal(output.includes(secret), false, `logged "${secret}"`);
  }
});
