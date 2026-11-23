// Integration: lines stored for a meeting reach the notes engine, and the notes
// go to the sockets of the people who brought Arlo in, in that meeting only.
// The model call is replaced: nothing leaves the machine.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', MEETING_FLUSH_GRACE_MS: '200' });

const test = require('node:test');
const assert = require('node:assert/strict');
const openrouter = require('../src/services/openrouter');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');
const { getNotesEngine } = require('../src/services/notesEngine');
const { getMeetingStore } = require('../src/storage');

let srv;
const realGenerate = openrouter.generateLiveNotes;
let modelCalls;
test.before(async () => { srv = await h.startServer(); });
test.beforeEach(() => {
  modelCalls = [];
  openrouter.generateLiveNotes = async (input) => {
    modelCalls.push(input);
    return { summary: `Notes from ${input.lines.length} lines.`, decisions: ['Ship Friday'], actionItems: [{ text: 'Release notes', owner: 'Ben' }] };
  };
});
test.after(() => {
  openrouter.generateLiveNotes = realGenerate;
  srv.server.closeAllConnections?.();
  srv.server.close();
});

const internal = { 'x-arlo-internal-key': h.internalKey() };
const say = (meetingId, streamId, text) => h.postJson(
  `${srv.base}/api/rtms/broadcast`,
  { meetingId, streamId, segment: { seqNo: 1, text, speakerId: '7', speakerLabel: 'Ana', tStartMs: 1000, tEndMs: 1000 } },
  internal,
);
const status = (meetingId, body) => h.postJson(`${srv.base}/api/rtms/status`, { meetingId, ...body }, internal);

function person(zoomUserId, displayName) {
  const user = userStore.upsert(zoomUserId, { email: `${zoomUserId}@example.test`, displayName, avatarUrl: null });
  return { user, zoomUserId, session: `sessionToken=${generateToken({ userId: user.id, zoomUserId })}` };
}
async function openPanel(meetingId, session) {
  const { cookie } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
  );
  const ws = await h.openWs(`${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`, { cookie: [cookie, session].filter(Boolean).join('; ') });
  assert.equal(ws.open, true);
  ws.socket.send(JSON.stringify({ type: 'subscribe', payload: { meetingId } }));
  await h.wait(100);
  return ws;
}
const notesSent = (ws) => ws.messages.filter((m) => m.type === 'notes.updated').map((m) => m.data);

test('after five stored lines the owner\'s panel gets the notes; nobody else\'s does', async () => {
  const meeting = 'NOTES-A==';
  const other = 'NOTES-A-OTHER==';
  const ana = person('zoom-notes-ana', 'Ana Ruiz');
  const ben = person('zoom-notes-ben', 'Ben Okafor');
  const owner = await openPanel(meeting, ana.session);
  const participant = await openPanel(meeting, ben.session);
  const guest = await openPanel(meeting, null);
  const ownerElsewhere = await openPanel(other, ana.session); // the same person, in another meeting

  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  for (let i = 1; i <= 5; i += 1) await say(meeting, 's1', `line ${i}`);
  await h.wait(200);
  for (const ws of [owner, participant, guest, ownerElsewhere]) ws.socket.close();

  assert.equal(modelCalls.length, 1);
  assert.deepEqual(modelCalls[0].lines, ['Ana: line 1', 'Ana: line 2', 'Ana: line 3', 'Ana: line 4', 'Ana: line 5']);
  assert.equal(modelCalls[0].previous, null);

  const got = notesSent(owner);
  assert.equal(got.length, 1);
  assert.equal(got[0].meetingId, meeting);
  assert.deepEqual(Object.keys(got[0]).sort(), ['meetingId', 'notes']);
  assert.equal(got[0].notes.summary, 'Notes from 5 lines.');
  assert.deepEqual(got[0].notes.decisions, ['Ship Friday']);
  assert.deepEqual(got[0].notes.actionItems, [{ text: 'Release notes', owner: 'Ben' }]);
  assert.equal(got[0].notes.throughSeqNo, 5);
  assert.equal(typeof got[0].notes.updatedAt, 'number');

  assert.deepEqual(notesSent(participant), []);
  assert.deepEqual(notesSent(guest), []);
  assert.deepEqual(notesSent(ownerElsewhere), []);
  assert.deepEqual(getMeetingStore().getNotes(meeting), got[0].notes);
});

test('a line that is dropped does not reach the engine', async () => {
  const meeting = 'NOTES-B==';
  const ana = person('zoom-notes-ana', 'Ana Ruiz');
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  await status(meeting, { status: 'rtms_started', streamId: 's2' });
  await say(meeting, 's1', 'kept');
  for (let i = 1; i <= 8; i += 1) await say(meeting, 's2', `the other stream ${i}`); // not the stored stream
  await h.postJson(`${srv.base}/api/rtms/broadcast`, { meetingId: meeting, streamId: 's1', segment: { text: '' } }, internal); // refused
  await h.wait(100);
  assert.equal(modelCalls.length, 0);
});

test('when the meeting ends, the notes go with it and the engine keeps nothing', async () => {
  const meeting = 'NOTES-C==';
  const ana = person('zoom-notes-ana', 'Ana Ruiz');
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  for (let i = 1; i <= 6; i += 1) await say(meeting, 's1', `line ${i}`);
  await h.wait(100);
  assert.notEqual(getMeetingStore().getNotes(meeting), null);
  const before = getNotesEngine().size();

  await status(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  assert.equal(getMeetingStore().getNotes(meeting), null);
  assert.equal(getNotesEngine().size(), before - 1);
});

test('a model answer that arrives after the meeting ended is not stored or sent', async () => {
  const meeting = 'NOTES-D==';
  const ana = person('zoom-notes-ana', 'Ana Ruiz');
  const owner = await openPanel(meeting, ana.session);
  let release;
  openrouter.generateLiveNotes = () => new Promise((resolve) => { release = () => resolve({ summary: 'Late.', decisions: [], actionItems: [] }); });
  await status(meeting, { status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId });
  for (let i = 1; i <= 5; i += 1) await say(meeting, 's1', `line ${i}`);
  await status(meeting, { status: 'rtms_stopped', streamId: 's1', meetingEnded: true });
  release();
  await h.wait(100);
  owner.socket.close();
  assert.equal(getMeetingStore().has(meeting), false);
  assert.deepEqual(notesSent(owner), []);
});
