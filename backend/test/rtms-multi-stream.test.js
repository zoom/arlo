// Integration: several users each run a stream in one meeting. The server
// keeps one transcript (each line once, whichever streams delivered it), and
// the meeting only counts as stopped when the last stream has stopped.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', MEETING_FLUSH_GRACE_MS: '200' });

const test = require('node:test');
const assert = require('node:assert/strict');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => { srv.server.closeAllConnections?.(); srv.server.close(); });

const internal = { 'x-arlo-internal-key': h.internalKey() };
// Each stream numbers its own lines from 1, as the rtms service does
const say = (meetingId, streamId, seqNo, text) => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, streamId, segment: { seqNo, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: 1000, tEndMs: 1000 } },
  internal,
);
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);
const events = (meetingId, streamId, list) => h.postJson(
  `${srv.base}/api/rtms/participant-event`, { meetingId, streamId, events: list }, internal,
);

async function cookieFor(meetingId) {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
  );
  return cookie;
}
async function history(meetingId, path, cookie) {
  const res = await fetch(`${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/${path}`, { headers: { cookie } });
  return (await res.json());
}
async function openPanel(meetingId, cookie) {
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, { cookie });
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId } }));
  await h.wait(100);
  return ws;
}
/** Run `fn` with the server's clock moved ahead (the tests share the process with it). */
async function later(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}
const ofType = (ws, type) => ws.messages.filter((m) => m.type === type).map((m) => m.data);
const texts = async (meetingId, cookie) => (await history(meetingId, 'transcript', cookie)).segments.map((s) => s.text);

test('a line both streams deliver is stored and sent to the panels once', async () => {
  const meeting = 'MULTI-A==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });

  const first = await say(meeting, 's1', 1, 'Heard on both streams.');
  const second = await say(meeting, 's2', 1, 'Heard on both streams.');
  const third = await say(meeting, 's2', 2, 'Delivered by the second stream only.');
  await h.wait(150);
  ws.socket.close();

  assert.equal(first.status, 200);
  assert.equal('stored' in first.body, false);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { received: true, stored: false, broadcast: 0 });
  assert.equal('stored' in third.body, false);
  const expected = ['Heard on both streams.', 'Delivered by the second stream only.'];
  assert.deepEqual(await texts(meeting, cookie), expected);
  assert.deepEqual(ofType(ws, 'transcript.segment').map((d) => d.segment.text), expected);
});

test('a stream that is ahead when the other stops loses nothing, and the numbers continue', async () => {
  const meeting = 'MULTI-B==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'one');
  await say(meeting, 's2', 1, 'one');
  await say(meeting, 's2', 2, 'two');
  await say(meeting, 's2', 3, 'three');

  // the first stream stops, and its copies of two and three never arrive
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await say(meeting, 's2', 4, 'four');

  const { segments } = await history(meeting, 'transcript', cookie);
  // each stream numbers its own lines: the stored numbers are the server's
  assert.deepEqual(segments.map((s) => [s.seqNo, s.text]), [[1, 'one'], [2, 'two'], [3, 'three'], [4, 'four']]);
});

test('a stream that is lines behind the other stores nothing twice', async () => {
  const meeting = 'MULTI-B2==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  for (const [n, text] of [[1, 'one'], [2, 'two'], [3, 'three']]) await say(meeting, 's1', n, text);
  await later(8000, async () => {
    await say(meeting, 's2', 1, 'one');
    await say(meeting, 's1', 4, 'four');
    for (const [n, text] of [[2, 'two'], [3, 'three'], [4, 'four']]) {
      assert.equal((await say(meeting, 's2', n, text)).body.stored, false);
    }
  });
  assert.deepEqual(await texts(meeting, cookie), ['one', 'two', 'three', 'four']);
});

test('the original host\'s stream starting changes nothing about what is stored, also when it delivers nothing', async () => {
  const { getMeetingStreams } = require('../src/services/meetingStreams');
  const meeting = 'MULTI-C==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await say(meeting, 's1', 1, 'before the host stream');
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-host', originalHost: true });
  assert.equal(getMeetingStreams().primaryOperator(meeting), 'op-host');
  await say(meeting, 's1', 2, 'while the host stream is silent');
  await later(40_000, () => say(meeting, 's1', 3, 'forty seconds on'));
  await later(41_000, async () => {
    await say(meeting, 's2', 1, 'from the host stream first');
    assert.equal((await say(meeting, 's1', 4, 'from the host stream first')).body.stored, false);
  });
  assert.deepEqual(await texts(meeting, cookie), [
    'before the host stream', 'while the host stream is silent', 'forty seconds on', 'from the host stream first',
  ]);

  // only the boolean counts
  const other = 'MULTI-C2==';
  await status(other, { status: 'rtms_started', streamId: 's1' });
  await status(other, { status: 'rtms_started', streamId: 's2', originalHost: 'true' });
  assert.equal(getMeetingStreams().isPrimary(other, 's1'), true);
});

test('the panels are told the meeting stopped only after the last stream stops', async () => {
  const meeting = 'MULTI-D==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's2', fault: true });
  await h.wait(100);
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started']);

  // a panel that opens now still finds a running stream
  const later = await openPanel(meeting, cookie);
  later.socket.close();
  assert.deepEqual(ofType(later, 'meeting.status').map((d) => d.status), ['rtms_started']);

  await status(meeting, { status: 'rtms_stopped', streamId: 's1', fault: true });
  await h.wait(100);
  ws.socket.close();
  const told = ofType(ws, 'meeting.status');
  assert.deepEqual(told.map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.equal(told[1].fault, true); // the last stream's fault is the meeting's

  // one "started" and one "stopped" line in the timeline, not one per stream
  const stored = (await history(meeting, 'participant-events', cookie)).events.map((e) => e.eventType);
  assert.deepEqual(stored, ['transcription_started', 'transcription_stopped']);
});

test('when the primary stream stops while it was reconnecting, the panels learn that a stream is running', async () => {
  const meeting = 'MULTI-E==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await status(meeting, { status: 'rtms_interrupted', streamId: 's1' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', fault: true });
  await h.wait(100);
  ws.socket.close();
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_interrupted', 'rtms_started']);
  assert.equal((await say(meeting, 's2', 1, 'kept')).body.stored, undefined);
});

test('trouble on a stream that is not the primary one is not shown to the meeting', async () => {
  const meeting = 'MULTI-F==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await status(meeting, { status: 'rtms_interrupted', streamId: 's2' });
  await status(meeting, { status: 'media_interrupted', streamId: 's2' });
  await status(meeting, { status: 'rtms_reconnected', streamId: 's2' });
  await status(meeting, { status: 'rtms_failed', streamId: 's2' });
  await status(meeting, { status: 'rtms_failed', streamId: 's3' }); // a third stream that never got in
  await h.wait(100);
  ws.socket.close();

  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started']);
  await say(meeting, 's1', 1, 'kept');
  assert.deepEqual(await texts(meeting, cookie), ['kept']);
});

test('a stream that fails while another runs does not start the idle flush', async () => {
  const meeting = 'MULTI-G==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await say(meeting, 's1', 1, 'kept');
  await status(meeting, { status: 'rtms_failed', streamId: 's2' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's3' });
  await h.wait(450); // longer than the grace period, and no panel is connected
  assert.deepEqual(await texts(meeting, cookie), ['kept']);
});

test('a participant event both streams report is kept once', async () => {
  const meeting = 'MULTI-H==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  const person = (eventType, id, name) => ({ eventType, participantName: name, participantId: id, timestamp: 1700000000000 });
  const first = await events(meeting, 's2', [person('joined', '12', 'Ben')]);
  const copy = await events(meeting, 's1', [person('joined', '12', 'Ben')]);
  // one of two is new: the list is taken event by event
  const mixed = await events(meeting, 's1', [person('joined', '13', 'Cy'), person('left', '12', 'Ben')]);
  const half = await events(meeting, 's2', [person('left', '12', 'Ben'), person('joined', '14', 'Di')]);
  // the people already there, as each stream lists them when it joins
  await events(meeting, 's1', [person('initial_roster', '12', 'Ben'), person('initial_roster', '13', 'Cy')]);
  const roster = await events(meeting, 's2', [person('initial_roster', '12', 'Ben'), person('initial_roster', '13', 'Cy')]);
  await h.wait(100);
  ws.socket.close();

  assert.equal('stored' in first.body, false);
  assert.deepEqual(copy.body, { received: true, stored: false, broadcast: 0 });
  assert.equal('stored' in mixed.body, false);
  assert.equal('stored' in half.body, false);
  assert.deepEqual(roster.body, { received: true, stored: false, broadcast: 0 });
  const expected = [
    ['transcription_started', null], ['joined', '12'], ['joined', '13'], ['left', '12'], ['joined', '14'],
    ['initial_roster', '12'], ['initial_roster', '13'],
  ];
  const stored = (await history(meeting, 'participant-events', cookie)).events.map((e) => [e.eventType, e.participantId]);
  assert.deepEqual(stored, expected);
  assert.deepEqual(ofType(ws, 'participant.event').map((d) => [d.event.eventType, d.event.participantId]), expected);
});

test('a stream that only reports participant events does not hold back another stream\'s lines', async () => {
  const meeting = 'MULTI-H2==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  for (const [n, text] of [[1, 'one'], [2, 'two'], [3, 'three']]) {
    await later(n * 20_000, async () => {
      await events(meeting, 's1', [{ eventType: 'joined', participantName: `P${n}`, participantId: String(n), timestamp: 1700000000000 }]);
      await say(meeting, 's2', n, text);
    });
  }
  assert.deepEqual(await texts(meeting, cookie), ['one', 'two', 'three']);
});

test('the meeting ending, reported on any one stream, ends every stream and flushes', async () => {
  const { getMeetingStreams } = require('../src/services/meetingStreams');
  const meeting = 'MULTI-I==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'Said during the meeting.');

  // only the boolean counts: this is one stream stopping, and the other runs on
  await status(meeting, { status: 'rtms_stopped', streamId: 's2', meetingEnded: 'true' });
  assert.deepEqual(await texts(meeting, cookie), ['Said during the meeting.']);
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });

  // the report comes on the stream that is not the primary one, while the other is live
  const ended = await status(meeting, { status: 'rtms_stopped', streamId: 's2', meetingEnded: true });
  assert.equal(ended.status, 200);
  assert.deepEqual(await texts(meeting, cookie), []);
  assert.deepEqual((await history(meeting, 'participant-events', cookie)).events, []);
  assert.equal(getMeetingStreams().anyLive(meeting), false);
  // what was known about the meeting's streams went with the flush
  assert.deepEqual(getMeetingStreams().operators(meeting), []);
  assert.equal((await say(meeting, 's1', 2, 'Arrived after the end.')).body.stored, false);

  // the other stream's own stop reports, with and without the reason, change nothing
  const later = await status(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', fault: true });
  await status(meeting, { status: 'rtms_failed', streamId: 's1' });
  assert.deepEqual(later.body, { received: true, broadcast: 0 });
  await h.wait(150);
  ws.socket.close();

  const told = ofType(ws, 'meeting.status');
  assert.deepEqual(told.map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.equal(told[1].meetingEnded, true);
  assert.equal('fault' in told[1], false);
  const lines = ofType(ws, 'participant.event').map((d) => d.event.eventType);
  assert.deepEqual(lines, ['transcription_started', 'transcription_stopped']);
  // each panel's last word about Arlo: not here
  assert.equal(ofType(ws, 'arlo.state').at(-1).present, false);
  assert.deepEqual(await texts(meeting, cookie), []);
  assert.equal((await say(meeting, 's1', 3, 'Still refused.')).body.stored, false);
});

test('after a meeting ended, a start or reconnect report or a line for it does not bring it back', async () => {
  const { getMeetingStreams } = require('../src/services/meetingStreams');
  const rtmsEvents = require('../src/lib/rtmsEvents');
  const meeting = 'MULTI-I2==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  const recorded = () => JSON.stringify(rtmsEvents.list('op-3', { since: 0 }));
  const before = recorded();

  // a report that was on its way, or a rejoin that got in as the meeting closed
  for (const report of [
    { status: 'rtms_started', streamId: 's3', operatorId: 'op-3' },
    { status: 'rtms_reconnected', streamId: 's2', operatorId: 'op-2' },
    { status: 'rtms_started' },
  ]) {
    const answer = await status(meeting, report);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { received: true, broadcast: 0 });
  }
  assert.equal((await say(meeting, 's3', 1, 'after the end')).body.stored, false);
  assert.equal((await say(meeting, 's9', 1, 'from a stream never heard of')).body.stored, false);
  await h.wait(100);
  ws.socket.close();

  assert.deepEqual(await texts(meeting, cookie), []);
  assert.deepEqual((await history(meeting, 'participant-events', cookie)).events, []);
  assert.equal(getMeetingStreams().anyLive(meeting), false);
  assert.deepEqual(getMeetingStreams().operators(meeting), []);
  assert.equal(recorded(), before);
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.equal(ofType(ws, 'arlo.state').at(-1).present, false);
  // the stop reports that follow are still answered quietly
  assert.deepEqual((await status(meeting, { status: 'rtms_stopped', streamId: 's3' })).body, { received: true, broadcast: 0 });
});

test('a stream that goes silent without a stop report loses nothing: the other stream\'s lines are stored as they come', async () => {
  const meeting = 'MULTI-N==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'one');
  assert.equal((await say(meeting, 's2', 1, 'one')).body.stored, false);
  await status(meeting, { status: 'rtms_interrupted', streamId: 's1' }); // the panels show "Reconnecting…"
  const kept = await say(meeting, 's2', 2, 'two'); // no wait: stored at once
  assert.equal('stored' in kept.body, false);
  await later(60_000, () => say(meeting, 's2', 3, 'three'));
  await later(120_000, () => say(meeting, 's2', 4, 'four'));
  await h.wait(100);
  ws.socket.close();

  const { segments } = await history(meeting, 'transcript', cookie);
  assert.deepEqual(segments.map((s) => [s.seqNo, s.text]), [[1, 'one'], [2, 'two'], [3, 'three'], [4, 'four']]);
  // a line from another running stream tells the panels that a stream is running, once
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_interrupted', 'rtms_started']);
});

test('a line still on its way from the interrupted stream itself does not end "Reconnecting…"', async () => {
  const meeting = 'MULTI-N2==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_interrupted', streamId: 's1' });
  await say(meeting, 's1', 1, 'was on its way');
  await h.wait(100);
  ws.socket.close();
  assert.deepEqual(await texts(meeting, cookie), ['was on its way']);
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_interrupted']);
});

test('an idle flush forgets the meeting\'s streams too', async () => {
  const { getMeetingStreams } = require('../src/services/meetingStreams');
  const meeting = 'MULTI-J==';
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await say(meeting, 's1', 1, 'x');
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  assert.deepEqual(getMeetingStreams().operators(meeting), ['op-1']); // kept through a stop
  await h.wait(450);
  assert.deepEqual(getMeetingStreams().operators(meeting), []);
});

test('reports without a stream id work as before: one stream per meeting', async () => {
  const meeting = 'MULTI-K==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', operatorId: 'op-1' });
  await say(meeting, undefined, 1, 'one');
  await status(meeting, { status: 'rtms_stopped' });
  await status(meeting, { status: 'rtms_started', operatorId: 'op-1' });
  await say(meeting, undefined, 1, 'two');
  await h.wait(100);
  ws.socket.close();

  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_stopped', 'rtms_started']);
  const { segments } = await history(meeting, 'transcript', cookie);
  assert.deepEqual(segments.map((s) => [s.seqNo, s.text]), [[1, 'one'], [2, 'two']]);
});

test('a stream id or operator id that is not a sane string is refused', async () => {
  const meeting = 'MULTI-L==';
  for (const bad of [42, '', 'x'.repeat(257), { id: 's1' }, ['s1']]) {
    assert.equal((await status(meeting, { status: 'rtms_started', streamId: bad })).status, 400);
    assert.equal((await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: bad })).status, 400);
    assert.equal((await say(meeting, bad, 1, 'x')).status, 400);
    assert.equal((await events(meeting, bad, [{ eventType: 'joined' }])).status, 400);
  }
  const cookie = await cookieFor(meeting);
  assert.deepEqual(await texts(meeting, cookie), []);
});

test('Zoom\'s own stop webhook for one of two streams, with the rtms service unreachable, is not a meeting stop', async () => {
  const meeting = 'MULTI-M==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await say(meeting, 's1', 1, 'kept');

  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's2', stop_reason: 1 } });
  await h.wait(100);
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started']);
  assert.deepEqual(await texts(meeting, cookie), ['kept']);

  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's1', stop_reason: 1 } });
  await h.wait(100);
  ws.socket.close();
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started', 'rtms_stopped']);
  assert.deepEqual(await texts(meeting, cookie), ['kept']);
});

test('Zoom\'s own stop webhook saying the meeting ended, for one of two streams, ends the meeting', async () => {
  const meeting = 'MULTI-O==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await say(meeting, 's1', 1, 'kept until the end');

  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's2', stop_reason: 6 } });
  assert.deepEqual(await texts(meeting, cookie), []);
  await h.postWebhook(srv.base, { event: 'meeting.rtms_stopped', payload: { meeting_uuid: meeting, rtms_stream_id: 's1', stop_reason: 6 } });
  await h.wait(100);
  ws.socket.close();
  const told = ofType(ws, 'meeting.status');
  assert.deepEqual(told.map((d) => [d.status, d.meetingEnded === true]), [['rtms_started', false], ['rtms_stopped', true]]);
  assert.deepEqual(await texts(meeting, cookie), []);
});

// --- no line is lost, and none stored twice, whichever stream delivers it -----

test('a stopped stream\'s line still on its way is stored, and the other stream\'s copy of it is not', async () => {
  const meeting = 'MULTI-P==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await say(meeting, 's1', 1, 'one');
  assert.equal((await say(meeting, 's2', 1, 'one')).body.stored, false);
  await status(meeting, { status: 'rtms_stopped', streamId: 's1' });
  await say(meeting, 's1', 2, 'two'); // was on its way when the stop was reported
  assert.equal((await say(meeting, 's2', 2, 'two')).body.stored, false);
  await say(meeting, 's2', 3, 'three');
  assert.deepEqual((await say(meeting, 's1', 3, 'three')).body, { received: true, stored: false, broadcast: 0 });
  await h.wait(100);
  ws.socket.close();

  assert.deepEqual(await texts(meeting, cookie), ['one', 'two', 'three']);
  assert.deepEqual(ofType(ws, 'transcript.segment').map((d) => d.segment.text), ['one', 'two', 'three']);
  // nothing was wrong for the panels: they are not told again that a stream runs
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status), ['rtms_started']);
  const { getMeetingStreams } = require('../src/services/meetingStreams');
  assert.equal(getMeetingStreams().isLive(meeting, 's1'), false); // not brought back by its late lines
});

test('three streams: each line is stored once', async () => {
  const meeting = 'MULTI-Q==';
  const cookie = await cookieFor(meeting);
  for (const id of ['s1', 's2', 's3']) await status(meeting, { status: 'rtms_started', streamId: id });
  for (const [id, n, text] of [
    ['s3', 1, 'one'], ['s1', 1, 'one'], ['s2', 1, 'one'], ['s2', 2, 'two'], ['s3', 2, 'two'], ['s3', 3, 'three'],
    ['s1', 2, 'two'], ['s1', 3, 'three'], ['s2', 3, 'three'],
  ]) await say(meeting, id, n, text);
  assert.deepEqual(await texts(meeting, cookie), ['one', 'two', 'three']);
});

test('the same words twice in a row by one speaker are two lines; the other stream\'s two copies are dropped', async () => {
  const meeting = 'MULTI-S==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  const yes = (streamId, tStartMs) => h.postJson(
    `${srv.base}/api/rtms/broadcast`,
    { meetingId: meeting, streamId, segment: { seqNo: 1, text: 'Yes.', speakerId: '7', speakerLabel: 'Ana', tStartMs, tEndMs: tStartMs } },
    internal,
  );
  await yes('s1', 1000);
  await yes('s1', 2500);
  assert.equal((await yes('s2', 1003)).body.stored, false); // the streams' clocks differ by a few ms
  assert.equal((await yes('s2', 2497)).body.stored, false);
  assert.deepEqual(await texts(meeting, cookie), ['Yes.', 'Yes.']);
});

test('copies without a timestamp are told by when they arrive; one that arrives 30 seconds late is stored again', async () => {
  const meeting = 'MULTI-T==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  const bare = (streamId, text) => h.postJson(
    `${srv.base}/api/rtms/broadcast`,
    { meetingId: meeting, streamId, segment: { seqNo: 1, text, speakerId: '7', speakerLabel: 'Ana' } },
    internal,
  );
  await bare('s1', 'one');
  assert.equal((await bare('s2', 'one')).body.stored, false);
  await bare('s1', 'two');
  await later(30_000, async () => {
    assert.equal('stored' in (await bare('s2', 'two')).body, false); // a duplicate, never a loss
  });
  assert.deepEqual(await texts(meeting, cookie), ['one', 'two', 'two']);
});

// --- a new stream carries what is said from when it started ------------------

const okay = (meetingId, streamId, tStartMs) => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  {
    meetingId,
    streamId,
    segment: { seqNo: 1, text: 'Okay.', speakerId: '7', speakerLabel: 'Ana', ...(tStartMs === undefined ? {} : { tStartMs, tEndMs: tStartMs }) },
  },
  internal,
);

test('the same words said again after a user replaced their stream are stored: the new stream did not exist for the first', async () => {
  const meeting = 'MULTI-U==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  assert.equal('stored' in (await okay(meeting, 's1', 100_000)).body, false);
  await later(2000, async () => {
    await status(meeting, { status: 'rtms_stopped', streamId: 's1', replaced: true });
    await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-1' });
  });
  const second = await later(3500, () => okay(meeting, 's2', 103_500));
  await h.wait(100);
  ws.socket.close();

  assert.equal('stored' in second.body, false);
  assert.deepEqual(await texts(meeting, cookie), ['Okay.', 'Okay.']);
  assert.equal(ofType(ws, 'transcript.segment').length, 2);
});

test('the same after a stream stopped and another user\'s started, with and without timestamps', async () => {
  for (const [meeting, first, second] of [['MULTI-V==', 100_000, 103_500], ['MULTI-V2==', undefined, undefined]]) {
    const cookie = await cookieFor(meeting);
    await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
    await okay(meeting, 's1', first);
    await later(1000, () => status(meeting, { status: 'rtms_stopped', streamId: 's1' }));
    await later(2500, () => status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' }));
    const again = await later(4000, () => okay(meeting, 's2', second));
    assert.equal('stored' in again.body, false, meeting);
    assert.deepEqual(await texts(meeting, cookie), ['Okay.', 'Okay.'], meeting);
  }
});

test('a stream that starts mid-meeting stores nothing twice from then on', async () => {
  const meeting = 'MULTI-W==';
  const cookie = await cookieFor(meeting);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await say(meeting, 's1', 1, 'before the second stream');
  await later(20_000, async () => {
    await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
    await say(meeting, 's1', 2, 'heard on both');
    assert.equal((await say(meeting, 's2', 1, 'heard on both')).body.stored, false);
    await say(meeting, 's2', 2, 'the second stream first');
    assert.equal((await say(meeting, 's1', 3, 'the second stream first')).body.stored, false);
  });
  assert.deepEqual(await texts(meeting, cookie), ['before the second stream', 'heard on both', 'the second stream first']);
});

test('stored lines do not tell the panels again what they are to Arlo: no `arlo.state` per line', async () => {
  const meeting = 'MULTI-X==';
  const cookie = await cookieFor(meeting);
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: 'op-1' });
  await status(meeting, { status: 'rtms_started', streamId: 's2', operatorId: 'op-2' });
  await h.wait(100);
  const before = ofType(ws, 'arlo.state').length;
  assert.ok(before > 0);

  const lineOn = (streamId, operatorId, n) => h.postJson(
    `${srv.base}/api/rtms/broadcast`,
    { meetingId: meeting, streamId, operatorId, segment: { seqNo: n, text: `line ${n}`, speakerId: '7', speakerLabel: 'Ana', tStartMs: n * 1000, tEndMs: n * 1000 } },
    internal,
  );
  for (let n = 1; n <= 20; n += 1) await lineOn('s1', 'op-1', n);
  // nor do copies, or participant events
  assert.equal((await lineOn('s2', 'op-2', 20)).body.stored, false);
  await events(meeting, 's2', [{ eventType: 'joined', participantName: 'Ben', participantId: '12', timestamp: 1700000000000 }]);
  await h.wait(150);
  ws.socket.close();

  assert.equal(ofType(ws, 'transcript.segment').length, 20);
  assert.equal(ofType(ws, 'arlo.state').length, before);
});

test('after twenty streams that stopped, a new stream\'s lines are stored', async () => {
  const meeting = 'MULTI-Y==';
  const cookie = await cookieFor(meeting);
  for (let n = 1; n <= 20; n += 1) {
    await status(meeting, { status: 'rtms_started', streamId: `old-${n}`, operatorId: `op-old-${n}` });
    await status(meeting, { status: 'rtms_stopped', streamId: `old-${n}` });
  }
  const ws = await openPanel(meeting, cookie);
  await status(meeting, { status: 'rtms_started', streamId: 'new', operatorId: 'op-new' });
  const kept = await say(meeting, 'new', 1, 'from the twenty-first stream');
  await h.wait(100);
  ws.socket.close();

  assert.equal('stored' in kept.body, false);
  assert.deepEqual(await texts(meeting, cookie), ['from the twenty-first stream']);
  assert.deepEqual(ofType(ws, 'meeting.status').map((d) => d.status).at(-1), 'rtms_started');
  assert.equal(ofType(ws, 'transcript.segment').length, 1);
});
