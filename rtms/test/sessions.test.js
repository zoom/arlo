// The RTMS session lifecycle, driven through a fake Zoom RTMS client. The real
// client is a native module that only runs in the Linux container.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSessionManager, reconnectDelay, isFaultStop,
  MAX_RECONNECT_ATTEMPTS, JOIN_CONFIRM_TIMEOUT_MS, AWAIT_ZOOM_SIGNAL_MS, STABLE_CONNECTION_MS,
} = require('../src/sessions');

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

function setup({ clientFactory, chaosDropAfterMs } = {}) {
  const clients = [];
  const sent = { status: [], segments: [], participantEvents: [] };
  const clock = { now: 1_000_000 };
  // Timers are collected, not run: a test fires the one it is about
  const timers = [];
  const schedule = (fn, ms) => {
    const timer = { fn, ms, cancelled: false, fired: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  const fire = (ms) => {
    const timer = pending().find((t) => t.ms === ms);
    assert.ok(timer, `no pending ${ms}ms timer (pending: ${pending().map((t) => t.ms).join(', ') || 'none'})`);
    timer.fired = true;
    clock.now += ms;
    timer.fn();
  };
  const manager = createSessionManager({
    createClient: clientFactory || (() => { const c = new FakeClient(); clients.push(c); return c; }),
    backend: {
      status: async (meetingId, status, extra) => { sent.status.push({ meetingId, status, ...extra }); },
      segment: async (meetingId, segment, extra) => { sent.segments.push({ meetingId, segment, ...extra }); },
      participantEvents: async (meetingId, events, extra) => { sent.participantEvents.push({ meetingId, events, ...extra }); },
    },
    now: () => clock.now,
    defer: (fn) => fn(),
    schedule,
    chaosDropAfterMs,
    log: { log() {}, warn() {}, error() {} },
  });
  return { manager, clients, sent, clock, fire, pending };
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
  assert.deepEqual(sent.status, [{ meetingId: 'MEETING-1==', status: 'rtms_started', streamId: 'stream-1', operatorId: 'op-1' }]);
  assert.equal(manager.size(), 1);
});

test('a first join that Zoom refuses (status 16) is retried, and reported as started when it gets in', async () => {
  const { manager, clients, sent, fire } = setup();
  await manager.started(started());
  clients[0].handlers.joinConfirm(16);
  await tick();

  // nothing is reported yet: Zoom keeps the stream open for about a minute
  assert.deepEqual(statuses(sent), []);
  assert.equal(clients[0].left, 1);
  assert.equal(manager.size(), 1);

  fire(3000);
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].joined, { meeting_uuid: 'MEETING-1==', rtms_stream_id: 'stream-1', server_urls: 'wss://zoom.example' });
  clients[1].handlers.joinConfirm(0);
  await tick();
  // a first start, not a reconnection: the operator goes with it
  assert.deepEqual(sent.status, [{ meetingId: 'MEETING-1==', status: 'rtms_started', streamId: 'stream-1', operatorId: 'op-1' }]);
});

test('a first join that keeps being refused is given up and reported as failed', async () => {
  const { manager, clients, sent, fire } = setup();
  await manager.started(started());
  clients[0].handlers.joinConfirm(16);
  for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
    fire(reconnectDelay(attempt));
    clients[attempt].handlers.joinConfirm(16);
  }
  await tick();

  assert.deepEqual(statuses(sent), ['rtms_failed']);
  assert.equal(manager.size(), 0);
  assert.ok(clients.every((c) => c.left === 1));

  // the same stream can be started again afterwards
  await manager.started(started());
  assert.equal(clients.length, MAX_RECONNECT_ATTEMPTS + 2);
});

test('Zoom ending a stream whose first join is still being retried is a fault, so the panel asks for a new one', async () => {
  const { manager, clients, sent, pending } = setup();
  await manager.started(started());
  clients[0].handlers.joinConfirm(16);
  await manager.stopped({ meeting_uuid: 'MEETING-1==', rtms_stream_id: 'stream-1', stop_reason: 2 });

  assert.deepEqual(pending(), []);
  assert.deepEqual(sent.status, [{ meetingId: 'MEETING-1==', status: 'rtms_stopped', streamId: 'stream-1', fault: true }]);
  assert.equal(manager.size(), 0);
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

// ---------------------------------------------------------------------------
// Several streams in one meeting: each Zoom user can run a stream of their own
// (own stream id, same meeting UUID), all at the same time.
// ---------------------------------------------------------------------------

const second = (overrides = {}) => started({ rtms_stream_id: 'stream-2', operator_id: 'op-2', ...overrides });

test('two users\' streams in one meeting both stay joined', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  await manager.started(second());
  clients[0].handlers.joinConfirm(0);
  clients[1].handlers.joinConfirm(0);
  await tick();

  assert.equal(clients[0].left, 0);
  assert.equal(clients[1].joined.rtms_stream_id, 'stream-2');
  assert.equal(manager.size(), 2);
  assert.deepEqual(sent.status, [
    { meetingId: 'MEETING-1==', status: 'rtms_started', streamId: 'stream-1', operatorId: 'op-1' },
    { meetingId: 'MEETING-1==', status: 'rtms_started', streamId: 'stream-2', operatorId: 'op-2' },
  ]);
});

test('the same user starting again replaces their own old stream, and nobody else\'s', async () => {
  const { manager, clients } = setup();
  await manager.started(started());
  await manager.started(second());
  await manager.started(started({ rtms_stream_id: 'stream-3' })); // op-1 again
  assert.deepEqual(clients.map((c) => c.left), [1, 0, 0]);
  assert.equal(clients[2].joined.rtms_stream_id, 'stream-3');
  assert.equal(manager.size(), 2);
});

test('streams whose user is not known are never taken for the same user', async () => {
  const { manager, clients } = setup();
  await manager.started(started({ operator_id: undefined }));
  await manager.started(second({ operator_id: undefined }));
  await manager.started(second({ rtms_stream_id: 'stream-3', operator_id: 42 }));
  assert.deepEqual(clients.map((c) => c.left), [0, 0, 0]);
  assert.equal(manager.size(), 3);
});

test('the same user in another meeting is left alone', async () => {
  const { manager, clients } = setup();
  await manager.started(started());
  await manager.started(started({ meeting_uuid: 'MEETING-2==', rtms_stream_id: 'stream-2' }));
  assert.deepEqual(clients.map((c) => c.left), [0, 0]);
});

test('a stop names one stream and the other keeps running', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  await manager.started(second());
  await manager.stopped({ meeting_uuid: 'MEETING-1==', rtms_stream_id: 'stream-2', stop_reason: 2 });

  assert.deepEqual(clients.map((c) => c.left), [0, 1]);
  assert.equal(manager.size(), 1);
  assert.deepEqual(sent.status, [{ meetingId: 'MEETING-1==', status: 'rtms_stopped', streamId: 'stream-2' }]);

  clients[0].handlers.transcript(Buffer.from('Still here.'), 11, 1_700_000_000_000_000, { userId: 7 });
  await tick();
  assert.equal(sent.segments.length, 1);
});

test('a stop that names a stream not held here does not end another user\'s stream', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  await manager.stopped({ meeting_uuid: 'MEETING-1==', rtms_stream_id: 'stream-7' });
  assert.equal(clients[0].left, 0);
  assert.equal(manager.size(), 1);
  // still passed on: the backend may know that stream from before this process started
  assert.deepEqual(sent.status, [{ meetingId: 'MEETING-1==', status: 'rtms_stopped', streamId: 'stream-7' }]);
});

test('a stop without a stream id is ignored when the meeting has two streams', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  await manager.started(second());
  await manager.stopped({ meeting_uuid: 'MEETING-1==', stop_reason: 6 });
  assert.deepEqual(clients.map((c) => c.left), [0, 0]);
  assert.equal(manager.size(), 2);
  assert.deepEqual(sent.status, []);
});

test('a stop without a stream id is reported with the id of the one stream it ended', async () => {
  const { manager, sent } = setup();
  await manager.started(started());
  await manager.stopped({ meeting_uuid: 'MEETING-1==' });
  assert.deepEqual(sent.status, [{ meetingId: 'MEETING-1==', status: 'rtms_stopped', streamId: 'stream-1' }]);
});

test('an interruption acts on the stream it names, and without a name only when there is one stream', async () => {
  const { manager, clients, sent, pending } = setup();
  await manager.started(started());
  await manager.started(second());
  clients[0].handlers.joinConfirm(0);
  clients[1].handlers.joinConfirm(0);
  await tick();
  sent.status.length = 0;

  await manager.interrupted({ meeting_uuid: 'MEETING-1==' });
  assert.deepEqual(clients.map((c) => c.left), [0, 0]);
  assert.deepEqual(sent.status, []);
  assert.deepEqual(pending(), []);

  await manager.interrupted({ meeting_uuid: 'MEETING-1==', rtms_stream_id: 'stream-2' });
  assert.deepEqual(clients.map((c) => c.left), [0, 1]);
  assert.deepEqual(sent.status, [{ meetingId: 'MEETING-1==', status: 'rtms_interrupted', streamId: 'stream-2' }]);
});

test('an interruption that names a stream not held here does not touch another user\'s stream', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  clients[0].handlers.joinConfirm(0);
  await tick();
  await manager.interrupted({ meeting_uuid: 'MEETING-1==', rtms_stream_id: 'stream-7' });
  assert.equal(clients[0].left, 0);
  assert.deepEqual(sent.status.at(-1), { meetingId: 'MEETING-1==', status: 'rtms_interrupted', streamId: 'stream-7' });
});

test('every report says which stream it is about', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  await manager.started(second());
  clients[1].handlers.joinConfirm(0);
  clients[1].handlers.participant('join', 1, [{ participantId: 11, userName: 'Ana' }]);
  clients[1].handlers.transcript(Buffer.from('Hello'), 5, 1_700_000_000_000_000, { userId: 11, userName: 'Ana' });
  clients[1].handlers.mediaInterrupted(1);
  clients[0].handlers.leave(3);
  await tick();

  assert.deepEqual(sent.status.map((s) => [s.status, s.streamId]), [
    ['rtms_started', 'stream-2'], ['media_interrupted', 'stream-2'], ['rtms_stopped', 'stream-1'],
  ]);
  assert.equal(sent.segments[0].streamId, 'stream-2');
  assert.equal(sent.participantEvents[0].streamId, 'stream-2');
});

test('the original host\'s stream is marked as such only when the webhook says true', async () => {
  const values = [true, 'true', 1, false, undefined];
  const { manager, clients, sent } = setup();
  for (const [i, value] of values.entries()) {
    await manager.started(started({ rtms_stream_id: `stream-${i}`, operator_id: `op-${i}`, is_original_host: value }));
    clients[i].handlers.joinConfirm(0);
  }
  await tick();

  assert.deepEqual(sent.status[0], {
    meetingId: 'MEETING-1==', status: 'rtms_started', streamId: 'stream-0', operatorId: 'op-0', originalHost: true,
  });
  assert.deepEqual(sent.status.map((s) => 'originalHost' in s), [true, false, false, false, false]);
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
    streamId: 'stream-1',
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
  // the connection is closed, but the SDK client still polls until it is released
  assert.equal(clients[0].left, 1);
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

// ---------------------------------------------------------------------------
// Failover and reconnection
// https://developers.zoom.us/docs/rtms/meetings/failover-reconnection/
// ---------------------------------------------------------------------------

const MEETING = 'MEETING-1==';
const interruptedPayload = (overrides = {}) => ({ meeting_uuid: MEETING, rtms_stream_id: 'stream-1', ...overrides });

async function streaming(options) {
  const ctx = setup(options);
  await ctx.manager.started(started());
  ctx.clients[0].handlers.joinConfirm(0);
  await tick();
  return ctx;
}

test('the backoff is 3s, doubling, capped at 30s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(reconnectDelay), [3000, 6000, 12000, 24000, 30000, 30000]);
});

test('stop reasons 10-19 and 24 are faults, the others are not', () => {
  const faults = Array.from({ length: 30 }, (_, i) => i).filter(isFaultStop);
  assert.deepEqual(faults, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 24]);
  assert.equal(isFaultStop(undefined), false);
  assert.equal(isFaultStop('13'), false);
});

test('scenario 1: rtms_started for a stream already held rejoins at once with the new server URLs', async () => {
  const { manager, clients, sent, pending } = await streaming();
  await manager.started(started({ server_urls: 'wss://zoom-2.example' }));

  assert.equal(clients[0].left, 1);
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].joined, { meeting_uuid: MEETING, rtms_stream_id: 'stream-1', server_urls: 'wss://zoom-2.example' });
  assert.deepEqual(pending().map((t) => t.ms), [JOIN_CONFIRM_TIMEOUT_MS]); // no backoff wait

  clients[1].handlers.joinConfirm(0);
  await tick();
  assert.deepEqual(statuses(sent), ['rtms_started', 'rtms_interrupted', 'rtms_reconnected']);
  assert.equal(manager.size(), 1);
});

test('scenario 2: rtms_interrupted rejoins signaling and media after 3 seconds', async () => {
  const { manager, clients, sent, fire } = await streaming();
  await manager.interrupted(interruptedPayload());

  assert.equal(clients[0].left, 1);
  assert.equal(clients.length, 1); // waits for the backoff
  fire(3000);
  assert.deepEqual(clients[1].joined, { meeting_uuid: MEETING, rtms_stream_id: 'stream-1', server_urls: 'wss://zoom.example' });

  clients[1].handlers.joinConfirm(0);
  await tick();
  assert.deepEqual(sent.status.slice(1), [
    { meetingId: MEETING, status: 'rtms_interrupted', streamId: 'stream-1' },
    { meetingId: MEETING, status: 'rtms_reconnected', streamId: 'stream-1', operatorId: 'op-1' },
  ]);
});

test('scenario 2: server URLs in the interruption replace the old ones', async () => {
  const { manager, clients, fire } = await streaming();
  await manager.interrupted(interruptedPayload({ server_urls: 'wss://zoom-3.example' }));
  fire(3000);
  assert.equal(clients[1].joined.server_urls, 'wss://zoom-3.example');
});

test('scenario 2: a refused or unconfirmed rejoin is retried with a growing delay, then given up', async () => {
  const { manager, clients, sent, fire, pending } = await streaming();
  await manager.interrupted(interruptedPayload());

  fire(3000);
  clients[1].handlers.joinConfirm(16); // refused
  fire(6000);
  fire(JOIN_CONFIRM_TIMEOUT_MS); // never confirmed
  fire(12000);
  clients[3].handlers.leave(13); // closed again before confirming
  fire(24000);
  clients[4].handlers.joinConfirm(16);
  fire(30000);
  assert.equal(clients.length, 1 + MAX_RECONNECT_ATTEMPTS);
  clients[5].handlers.joinConfirm(16);
  await tick();

  assert.equal(clients.length, 1 + MAX_RECONNECT_ATTEMPTS); // no sixth attempt
  assert.equal(manager.size(), 0);
  assert.deepEqual(pending(), []);
  assert.deepEqual(statuses(sent), ['rtms_started', 'rtms_interrupted', 'rtms_failed']);
});

test('the attempt count starts over after a connection that held', async () => {
  const { manager, clients, clock, fire } = await streaming();
  await manager.interrupted(interruptedPayload());
  fire(3000);
  clients[1].handlers.joinConfirm(16);
  fire(6000);
  clients[2].handlers.joinConfirm(0);
  clock.now += STABLE_CONNECTION_MS + 1;

  await manager.interrupted(interruptedPayload(), clock.now);
  fire(3000); // back to the first delay
  assert.equal(clients.length, 4);
});

test('a connection that keeps dropping right after it rejoins is given up, not retried forever', async () => {
  const { manager, clients, sent, clock, fire } = await streaming();
  const delays = [3000, 6000, 12000, 24000, 30000];
  for (const [i, delay] of delays.entries()) {
    await manager.interrupted(interruptedPayload(), clock.now + 1);
    fire(delay);
    clients[i + 1].handlers.joinConfirm(0);
  }
  await manager.interrupted(interruptedPayload(), clock.now + 1);
  await tick();
  assert.equal(manager.size(), 0);
  assert.equal(statuses(sent).at(-1), 'rtms_failed');
});

test('an interruption while already reconnecting does not start a second reconnect', async () => {
  const { manager, clients, sent, fire, pending } = await streaming();
  await manager.interrupted(interruptedPayload());
  await manager.interrupted(interruptedPayload());
  assert.deepEqual(pending().map((t) => t.ms), [3000]);
  fire(3000);
  await manager.interrupted(interruptedPayload()); // join in flight
  assert.equal(clients.length, 2);
  await tick();
  assert.deepEqual(statuses(sent), ['rtms_started', 'rtms_interrupted']);
});

test('an interruption sent before the current connection was confirmed is ignored', async () => {
  const { manager, clients, sent, clock, fire } = await streaming();
  const before = clock.now;
  await manager.interrupted(interruptedPayload());
  fire(3000);
  clients[1].handlers.joinConfirm(0);

  await manager.interrupted(interruptedPayload(), before); // late delivery
  await tick();
  assert.equal(clients[1].left, 0);
  assert.deepEqual(statuses(sent), ['rtms_started', 'rtms_interrupted', 'rtms_reconnected']);
});

test('an interruption for a stream this process does not know rejoins when Zoom gives the server URLs', async () => {
  const { manager, clients, sent, fire } = setup();
  await manager.interrupted(interruptedPayload({ server_urls: 'wss://zoom.example' }));
  fire(3000);
  clients[0].handlers.joinConfirm(0);
  await tick();
  assert.deepEqual(statuses(sent), ['rtms_interrupted', 'rtms_reconnected']);
  assert.equal(manager.size(), 1);
});

test('an interruption for an unknown stream without server URLs is reported and nothing is joined', async () => {
  const { manager, clients, sent, pending } = setup();
  await manager.interrupted(interruptedPayload());
  await manager.interrupted({ meeting_uuid: 42 });
  await tick();
  assert.equal(clients.length, 0);
  assert.deepEqual(pending(), []);
  assert.deepEqual(statuses(sent), ['rtms_interrupted']);
});

test('scenario 3: a media interruption rejoins the stream after 3 seconds', async () => {
  const { manager, clients, sent, fire } = await streaming();
  clients[0].handlers.mediaInterrupted(123);
  assert.equal(clients[0].left, 1);
  fire(3000);
  clients[1].handlers.joinConfirm(0);
  await tick();
  assert.deepEqual(statuses(sent), ['rtms_started', 'media_interrupted', 'rtms_reconnected']);
  assert.equal(manager.size(), 1);
});

test('a media interruption before the join is confirmed is reported and the session is kept', async () => {
  const { manager, clients, sent } = setup();
  await manager.started(started());
  clients[0].handlers.mediaInterrupted(123);
  await tick();
  assert.deepEqual(statuses(sent), ['media_interrupted']);
  assert.equal(manager.size(), 1);
});

test('scenario 4: a stop with a fault reason is reported as a fault', async () => {
  for (const [reason, fault] of [[13, true], [19, true], [24, true], [2, false], [undefined, false]]) {
    const { manager, sent } = await streaming();
    await manager.stopped({ meeting_uuid: MEETING, rtms_stream_id: 'stream-1', stop_reason: reason });
    assert.deepEqual(sent.status.at(-1), fault
      ? { meetingId: MEETING, status: 'rtms_stopped', streamId: 'stream-1', fault: true }
      : { meetingId: MEETING, status: 'rtms_stopped', streamId: 'stream-1' }, `reason ${reason}`);
    assert.equal(manager.size(), 0);
  }
});

test('a stop because the meeting ended says so, from the webhook or from the closed connection', async () => {
  const viaWebhook = await streaming();
  await viaWebhook.manager.stopped({ meeting_uuid: MEETING, rtms_stream_id: 'stream-1', stop_reason: 6 });
  assert.deepEqual(viaWebhook.sent.status.at(-1), { meetingId: MEETING, status: 'rtms_stopped', streamId: 'stream-1', meetingEnded: true });

  const viaConnection = await streaming();
  viaConnection.clients[0].handlers.leave(6);
  await tick();
  assert.deepEqual(viaConnection.sent.status.at(-1), { meetingId: MEETING, status: 'rtms_stopped', streamId: 'stream-1', meetingEnded: true });

  const hostStopped = await streaming();
  hostStopped.clients[0].handlers.leave(1);
  await tick();
  assert.deepEqual(hostStopped.sent.status.at(-1), { meetingId: MEETING, status: 'rtms_stopped', streamId: 'stream-1' });
});

test('a stop that lands while the connection is being recovered is a fault, and cancels the reconnect', async () => {
  const { manager, clients, sent, pending } = await streaming();
  await manager.interrupted(interruptedPayload());
  await manager.stopped({ meeting_uuid: MEETING, rtms_stream_id: 'stream-1', stop_reason: 20 });
  assert.deepEqual(pending(), []);
  assert.equal(clients.length, 1);
  assert.deepEqual(sent.status.at(-1), { meetingId: MEETING, status: 'rtms_stopped', streamId: 'stream-1', fault: true });
});

test('a connection that closes without a deliberate stop waits for Zoom, and is not rejoined on its own', async () => {
  const { manager, clients, sent, fire } = await streaming();
  clients[0].handlers.leave(13);
  await tick();
  assert.equal(clients.length, 1);
  assert.equal(manager.size(), 1);
  assert.deepEqual(statuses(sent), ['rtms_started', 'rtms_interrupted']);

  // Zoom then says the signaling connection dropped: now it is rejoined
  await manager.interrupted(interruptedPayload());
  fire(3000);
  clients[1].handlers.joinConfirm(0);
  await tick();
  assert.equal(statuses(sent).at(-1), 'rtms_reconnected');
});

test('if Zoom never says what happened to a closed connection, the stream is reported as lost', async () => {
  const { manager, clients, sent, fire } = await streaming();
  clients[0].handlers.leave(0);
  fire(AWAIT_ZOOM_SIGNAL_MS);
  await tick();
  assert.equal(manager.size(), 0);
  assert.deepEqual(sent.status.at(-1), { meetingId: MEETING, status: 'rtms_stopped', streamId: 'stream-1', fault: true });
});

test('callbacks from a replaced client are ignored', async () => {
  const { manager, clients, sent, fire } = await streaming();
  await manager.interrupted(interruptedPayload());
  fire(3000);
  clients[1].handlers.joinConfirm(0);
  const before = sent.status.length;

  clients[0].handlers.leave(13);
  clients[0].handlers.joinConfirm(0);
  clients[0].handlers.transcript(Buffer.from('late'), 4, 1, { userId: 1 });
  clients[0].handlers.participant('leave', 1, [{ participantId: 11 }]);
  await tick();
  assert.equal(sent.status.length, before);
  assert.equal(sent.segments.length, 0);
  assert.equal(sent.participantEvents.length, 0);
});

test('after a rejoin the people in the meeting are a roster again, and segment numbers continue', async () => {
  const { manager, clients, sent, fire } = await streaming();
  clients[0].handlers.transcript(Buffer.from('Before.'), 7, 1_700_000_000_000_000, { userId: 11, userName: 'Ana' });
  await manager.interrupted(interruptedPayload());
  fire(3000);
  clients[1].handlers.joinConfirm(0);
  clients[1].handlers.participant('join', 1, [{ participantId: 11, userName: 'Ana' }]);
  clients[1].handlers.transcript(Buffer.from('After.'), 6, 1_700_000_009_000_000, { userId: 11, userName: 'Ana' });
  await tick();

  assert.deepEqual(sent.participantEvents.flatMap((p) => p.events).map((e) => e.eventType), ['initial_roster']);
  assert.deepEqual(sent.segments.map((s) => s.segment.seqNo), [1, 2]);
});

test('chaos mode drops the connection after the delay and waits for Zoom like a real drop', async () => {
  const { manager, clients, sent, fire } = await streaming({ chaosDropAfterMs: 15000 });
  fire(15000);
  await tick();
  assert.equal(clients[0].left, 1);
  assert.equal(manager.size(), 1);
  assert.deepEqual(statuses(sent), ['rtms_started', 'rtms_interrupted']);
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
