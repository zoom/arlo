// An approval nobody answers runs out: the owners and the person who asked are
// told "expired". Runs with a short expiry (APPROVAL_EXPIRY_MS) on the real server.
const h = require('./helpers');

h.setTestEnv({ RTMS_SERVICE_URL: 'http://127.0.0.1:9', APPROVAL_EXPIRY_MS: '400' });

const test = require('node:test');
const assert = require('node:assert/strict');
const { userStore } = require('../src/lib/memoryStore');
const { generateToken } = require('../src/services/auth');

let srv;
test.before(async () => { srv = await h.startServer(); });
test.after(() => {
  srv.server.closeAllConnections?.();
  srv.server.close();
});

const internal = { 'x-arlo-internal-key': h.internalKey() };
let people = 0;
function person(displayName) {
  people += 1;
  const zoomUserId = `zoom-approval-expiry-${people}`;
  const user = userStore.upsert(zoomUserId, { email: `${zoomUserId}@example.test`, displayName, avatarUrl: null });
  return { user, zoomUserId, session: `sessionToken=${generateToken({ userId: user.id, zoomUserId })}` };
}
const url = (meetingId, path) => `${srv.base}/api/meetings/by-zoom-id/${encodeURIComponent(meetingId)}/arlo/${path}`;
const approvalMessages = (ws) => ws.messages.filter((msg) => msg.type.startsWith('arlo.approval'));

test('an unanswered request closes as "expired" for the owner and the asker only', async () => {
  const meetingId = 'NR-EXPIRY==';
  const [ana, ben, dee] = [person('Ana Ruiz'), person('Ben Okafor'), person('Dee Marsh')];
  const { cookie: pass } = await h.postJson(
    `${srv.base}/api/auth/meeting-access`,
    { appContext: h.makeAppContext(h.meetingPayload({ mid: meetingId })) },
  );
  await h.postJson(`${srv.base}/api/rtms/status`, { meetingId, status: 'rtms_started', streamId: 's1', operatorId: ana.zoomUserId }, internal);
  await h.postJson(`${srv.base}/api/rtms/broadcast`, {
    meetingId, streamId: 's1', segment: { seqNo: 1, text: 'Hello.', speakerId: '7', speakerLabel: 'Ana', tStartMs: 1, tEndMs: 1 },
  }, internal);
  const as = (who) => ({ cookie: `${pass}; ${who.session}` });
  const wsUrl = `${srv.wsBase}?meeting_id=${encodeURIComponent(meetingId)}`;
  const [ownerPanel, askerPanel, thirdPanel] = await Promise.all([h.openWs(wsUrl, as(ana)), h.openWs(wsUrl, as(ben)), h.openWs(wsUrl, as(dee))]);
  await h.wait(50);

  const asked = await h.postJson(url(meetingId, 'notes-request'), {}, as(ben));
  assert.equal(asked.status, 200);
  const { id, expiresAt } = asked.body;
  assert.ok(expiresAt - Date.now() <= 400);
  const list = async () => (await (await fetch(url(meetingId, 'approvals'), { headers: as(ana) })).json()).approvals;
  assert.equal((await list()).length, 1);

  await h.wait(700);
  const closed = { type: 'arlo.approval.closed', data: { meetingId, id, outcome: 'expired' } };
  assert.deepEqual(approvalMessages(ownerPanel).at(-1), closed);
  assert.equal(approvalMessages(ownerPanel).length, 2);
  assert.deepEqual(approvalMessages(askerPanel), [closed]);
  assert.deepEqual(approvalMessages(thirdPanel), []);

  assert.deepEqual(await list(), []);
  const late = await h.postJson(url(meetingId, `approvals/${id}`), { approve: true, done: true }, as(ana));
  assert.equal(late.status, 404);
  // it ran out, and the person still asked a moment ago
  assert.equal((await h.postJson(url(meetingId, 'notes-request'), {}, as(ben))).status, 429);
  for (const ws of [ownerPanel, askerPanel, thirdPanel]) ws.socket.close();
});
