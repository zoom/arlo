// Unit tests for Zoom App Context verification and meeting-access tokens.
const { setTestEnv, makeAppContext, meetingPayload, TEST_CLIENT_SECRET } = require('./helpers');

setTestEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  verifyMeetingAppContext, issueMeetingAccessToken, verifyMeetingAccessToken, AppContextError,
} = require('../src/services/zoomAppContext');
const { generateToken, verifySessionToken } = require('../src/services/auth');

const verify = (ctx, opts) => verifyMeetingAppContext(ctx, { clientSecret: TEST_CLIENT_SECRET, ...opts });
const rejects = (fn, why) => assert.throws(fn, AppContextError, why);

test('accepts a valid meeting context and returns its meeting', () => {
  const result = verify(makeAppContext(meetingPayload()));
  assert.equal(result.meetingId, 'MEETING-A==');
  assert.equal(result.zoomUserId, 'zoom-user-1');
  assert.equal(result.parentMeetingId, null);
});

test('accepts exp in seconds as well as milliseconds', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  assert.equal(verify(makeAppContext(meetingPayload({ exp }))).meetingId, 'MEETING-A==');
});

test('accepts contexts with and without additional authenticated data', () => {
  assert.ok(verify(makeAppContext(meetingPayload(), { aad: Buffer.alloc(0) })));
  assert.ok(verify(makeAppContext(meetingPayload(), { aad: Buffer.from('zoom-aad') })));
});

test('accepts webinar contexts and keeps the breakout parent id', () => {
  const r = verify(makeAppContext(meetingPayload({ typ: 'webinar', pid: 'MAIN-MEETING' })));
  assert.equal(r.parentMeetingId, 'MAIN-MEETING');
});

test('rejects expired contexts', () => {
  rejects(() => verify(makeAppContext(meetingPayload({ exp: Date.now() - 1000 }))), 'expired');
});

test('rejects contexts that are not inside a meeting', () => {
  rejects(() => verify(makeAppContext(meetingPayload({ typ: 'panel', mid: undefined }))), 'panel');
  rejects(() => verify(makeAppContext(meetingPayload({ mid: '' }))), 'empty mid');
  rejects(() => verify(makeAppContext(meetingPayload({ mid: 'x'.repeat(201) }))), 'long mid');
});

test('rejects contexts encrypted with a different secret', () => {
  rejects(() => verify(makeAppContext(meetingPayload(), { secret: 'some-other-secret' })));
});

test('rejects tampered ciphertext', () => {
  rejects(() => verify(makeAppContext(meetingPayload(), { tamper: true })));
});

test('rejects garbage, missing and oversized input', () => {
  rejects(() => verify('AAAA'));
  rejects(() => verify(undefined));
  rejects(() => verify(''));
  rejects(() => verify('A'.repeat(9000)));
});

test('meeting-access tokens round-trip and are bound to one meeting', () => {
  const token = issueMeetingAccessToken({ meetingId: 'MEETING-A==', zoomUserId: 'z1', userId: null });
  const payload = verifyMeetingAccessToken(token);
  assert.equal(payload.meetingId, 'MEETING-A==');
});

test('session tokens and meeting-access tokens cannot be swapped', () => {
  const access = issueMeetingAccessToken({ meetingId: 'MEETING-A==' });
  assert.throws(() => verifySessionToken(access), 'access token used as session');

  const session = generateToken({ userId: 'u1', zoomUserId: 'z1' });
  assert.throws(() => verifyMeetingAccessToken(session), 'session used as access token');
  assert.equal(verifySessionToken(session).userId, 'u1');
});
