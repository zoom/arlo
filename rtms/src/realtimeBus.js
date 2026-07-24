const os = require('os');
const Redis = require('ioredis');
const realtimeEncryption = require('./realtimeEncryption');

const activeTtlSeconds = parseInt(process.env.REALTIME_ACTIVE_TTL_SECONDS || '86400', 10);
const completedTtlSeconds = parseInt(process.env.REALTIME_COMPLETED_TTL_SECONDS || '3600', 10);
const replayLimit = parseInt(process.env.REALTIME_REPLAY_LIMIT || '250', 10);
const instanceId = `${os.hostname()}-${process.pid}`;

let client = null;
let connectPromise = null;

function enabled() {
  return !!process.env.REDIS_URL;
}

function keyPrefix() {
  return process.env.REALTIME_KEY_PREFIX || 'arlo:realtime';
}

function channelPrefix() {
  return process.env.REALTIME_CHANNEL_PREFIX || 'arlo:realtime';
}

function encodeId(value) {
  return Buffer.from(String(value || 'unknown')).toString('base64url');
}

function keysForSession(sessionId, prefix = keyPrefix()) {
  return {
    session: `${prefix}:session:${sessionId}`,
    events: `${prefix}:session:${sessionId}:events`,
  };
}

function aliasKey(type, value, prefix = keyPrefix()) {
  return `${prefix}:alias:${type}:${encodeId(value)}`;
}

function userKey(type, value, prefix = keyPrefix()) {
  return `${prefix}:${type}:${encodeId(value)}:active_session`;
}

function channelForMeeting(meetingId, prefix = channelPrefix()) {
  return `${prefix}:meeting:${encodeId(meetingId)}`;
}

function meetingStreamAliasValue(meetingId, rtmsStreamId) {
  return `${meetingId}:${rtmsStreamId}`;
}

function defaultSessionId(meetingId, rtmsStreamId) {
  return rtmsStreamId
    ? `rtms:${encodeId(meetingStreamAliasValue(meetingId, rtmsStreamId))}`
    : `rtms:${encodeId(meetingId)}`;
}

function sessionHasIdentity(session) {
  return !!(session?.appUserId || session?.zoomUserId || session?.operatorId);
}

function sessionMatchesIdentity(session, metadata = {}, { allowUnclaimed = true } = {}) {
  if (!session) return false;

  const candidateZoomUserId = metadata.zoomUserId || metadata.operatorId || null;
  if (metadata.appUserId && session.appUserId && session.appUserId === metadata.appUserId) {
    return true;
  }
  if (candidateZoomUserId) {
    if (session.zoomUserId && session.zoomUserId === candidateZoomUserId) return true;
    if (session.operatorId && session.operatorId === candidateZoomUserId) return true;
  }

  return allowUnclaimed && !sessionHasIdentity(session);
}

async function getClient() {
  if (!enabled()) return null;
  if (client?.status === 'ready') return client;
  if (connectPromise) return connectPromise;

  client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    connectionName: `arlo-rtms-${instanceId}`.slice(0, 64),
    retryStrategy(times) {
      return Math.min(times * 250, 5000);
    },
  });
  client.on('error', (err) => console.warn('Valkey RTMS publisher error:', err.message));

  connectPromise = client.connect()
    .then(() => client)
    .catch((error) => {
      connectPromise = null;
      console.warn('Valkey RTMS publisher unavailable:', error.message);
      return null;
    });
  return connectPromise;
}

async function readSession(sessionId) {
  const redis = await getClient();
  if (!redis || !sessionId) return null;
  const raw = await redis.get(keysForSession(sessionId).session);
  return raw ? JSON.parse(raw) : null;
}

async function resolveSession({ meetingId, rtmsStreamId, appUserId, zoomUserId } = {}) {
  const redis = await getClient();
  if (!redis) return null;
  const hasIdentity = !!(appUserId || zoomUserId);
  const aliases = [];
  if (appUserId) aliases.push(userKey('app-user', appUserId));
  if (zoomUserId) aliases.push(userKey('zoom-user', zoomUserId));
  if (meetingId && rtmsStreamId) aliases.push(aliasKey('meeting-stream', meetingStreamAliasValue(meetingId, rtmsStreamId)));
  if (rtmsStreamId) aliases.push(aliasKey('rtms-stream', rtmsStreamId));
  if (!rtmsStreamId && meetingId) aliases.push(aliasKey('meeting', meetingId));

  for (const key of aliases) {
    const sessionId = await redis.get(key);
    if (sessionId) {
      const session = await readSession(sessionId);
      if (!hasIdentity || sessionMatchesIdentity(session, { appUserId, zoomUserId })) {
        return session;
      }
    }
  }
  return null;
}

async function upsertSession(metadata = {}) {
  const redis = await getClient();
  if (!redis) return null;

  const existing = await resolveSession(metadata);
  const sessionId = existing?.sessionId ||
    metadata.sessionId ||
    defaultSessionId(metadata.rtmsMeetingId || metadata.meetingId, metadata.rtmsStreamId);
  const now = Date.now();
  const session = {
    ...(existing || {}),
    ...metadata,
    sessionId,
    meetingId: metadata.meetingId || metadata.rtmsMeetingId || existing?.meetingId,
    rtmsMeetingId: metadata.rtmsMeetingId || metadata.meetingId || existing?.rtmsMeetingId,
    realtimeKeyPrefix: metadata.realtimeKeyPrefix || existing?.realtimeKeyPrefix || keyPrefix(),
    realtimeChannelPrefix: metadata.realtimeChannelPrefix || existing?.realtimeChannelPrefix || channelPrefix(),
    updatedAt: now,
    createdAt: existing?.createdAt || now,
  };
  const realtimeEncryptionMetadata = await realtimeEncryption.ensureSessionEncryption(session);
  if (realtimeEncryptionMetadata) {
    session.realtimeEncryption = realtimeEncryptionMetadata;
  }
  const ttl = session.status === 'completed' ? completedTtlSeconds : activeTtlSeconds;
  const sessionKeys = keysForSession(sessionId);
  const pipeline = redis.pipeline();
  pipeline.set(sessionKeys.session, JSON.stringify(session), 'EX', ttl);
  [
    ['meeting-stream', session.meetingId && session.rtmsStreamId ? meetingStreamAliasValue(session.meetingId, session.rtmsStreamId) : null],
    ['meeting-stream', session.sdkMeetingId && session.rtmsStreamId ? meetingStreamAliasValue(session.sdkMeetingId, session.rtmsStreamId) : null],
    ['meeting-stream', session.rtmsMeetingId && session.rtmsStreamId ? meetingStreamAliasValue(session.rtmsMeetingId, session.rtmsStreamId) : null],
    ['meeting', session.meetingId],
    ['meeting', session.sdkMeetingId],
    ['meeting', session.rtmsMeetingId],
    ['client-session', session.clientSessionId],
    ['rtms-stream', session.rtmsStreamId],
  ].forEach(([type, value]) => {
    if (value) pipeline.set(aliasKey(type, value), sessionId, 'EX', ttl);
  });
  if (session.appUserId) pipeline.set(userKey('app-user', session.appUserId), sessionId, 'EX', ttl);
  if (session.zoomUserId) pipeline.set(userKey('zoom-user', session.zoomUserId), sessionId, 'EX', ttl);
  pipeline.expire(sessionKeys.events, ttl);
  await pipeline.exec();
  return session;
}

async function publishEnvelope(type, meetingId, payload = {}, metadata = {}) {
  const redis = await getClient();
  if (!redis || !meetingId) return false;

  const session = await upsertSession({
    ...metadata,
    meetingId,
    rtmsMeetingId: metadata.rtmsMeetingId || meetingId,
  });
  if (!session) return false;

  const envelope = {
    type,
    meetingId,
    sessionId: session.sessionId,
    sdkMeetingId: session.sdkMeetingId || null,
    rtmsMeetingId: session.rtmsMeetingId || meetingId,
    rtmsStreamId: session.rtmsStreamId || null,
    clientSessionId: session.clientSessionId || null,
    realtimeKeyPrefix: session.realtimeKeyPrefix || keyPrefix(),
    realtimeChannelPrefix: session.realtimeChannelPrefix || channelPrefix(),
    appUserId: session.appUserId || null,
    zoomUserId: session.zoomUserId || null,
    operatorId: session.operatorId || null,
    originInstanceId: instanceId,
    publishedAt: Date.now(),
    ...payload,
  };
  const ttl = type === 'meeting.status' && payload.status === 'rtms_stopped'
    ? completedTtlSeconds
    : activeTtlSeconds;
  const sessionKeys = keysForSession(session.sessionId);
  const envelopeForStorage = await realtimeEncryption.encryptEnvelope(envelope, session);
  const serialized = JSON.stringify(envelopeForStorage);
  await redis
    .pipeline()
    .rpush(sessionKeys.events, serialized)
    .ltrim(sessionKeys.events, -replayLimit, -1)
    .expire(sessionKeys.events, ttl)
    .publish(channelForMeeting(meetingId), serialized)
    .exec();
  return true;
}

async function publishTranscriptSegment(meetingId, segment, metadata) {
  return publishEnvelope('transcript.segment', meetingId, { segment }, metadata);
}

async function publishParticipantEvent(meetingId, event, metadata) {
  return publishEnvelope('participant.event', meetingId, { event }, metadata);
}

async function recordRtmsSession(metadata) {
  return upsertSession({
    ...metadata,
    status: metadata.status || 'rtms_started',
  });
}

async function completeMeeting(meetingId) {
  const session = await resolveSession({ meetingId });
  if (!session) return false;
  await upsertSession({ ...session, status: 'completed', completedAt: Date.now() });
  return true;
}

async function deleteMeeting(meetingId, rtmsStreamId) {
  const redis = await getClient();
  if (!redis || !meetingId) return false;

  const session = await resolveSession({ meetingId, rtmsStreamId });
  const pipeline = redis.pipeline();

  const prefixes = new Set([keyPrefix(), session?.realtimeKeyPrefix].filter(Boolean));
  prefixes.forEach((prefix) => {
    if (session?.sessionId) {
      const sessionKeys = keysForSession(session.sessionId, prefix);
      pipeline.del(sessionKeys.session);
      pipeline.del(sessionKeys.events);
    }

    [
      ['meeting', meetingId],
      ['meeting', session?.meetingId],
      ['meeting', session?.sdkMeetingId],
      ['meeting', session?.rtmsMeetingId],
      ['meeting-stream', meetingId && rtmsStreamId ? meetingStreamAliasValue(meetingId, rtmsStreamId) : null],
      ['meeting-stream', session?.meetingId && session?.rtmsStreamId ? meetingStreamAliasValue(session.meetingId, session.rtmsStreamId) : null],
      ['meeting-stream', session?.sdkMeetingId && session?.rtmsStreamId ? meetingStreamAliasValue(session.sdkMeetingId, session.rtmsStreamId) : null],
      ['meeting-stream', session?.rtmsMeetingId && session?.rtmsStreamId ? meetingStreamAliasValue(session.rtmsMeetingId, session.rtmsStreamId) : null],
      ['client-session', session?.clientSessionId],
      ['rtms-stream', rtmsStreamId],
      ['rtms-stream', session?.rtmsStreamId],
    ].forEach(([type, value]) => {
      if (value) pipeline.del(aliasKey(type, value, prefix));
    });
    if (session?.appUserId) pipeline.del(userKey('app-user', session.appUserId, prefix));
    if (session?.zoomUserId) pipeline.del(userKey('zoom-user', session.zoomUserId, prefix));
    if (session?.operatorId && session.operatorId !== session.zoomUserId) {
      pipeline.del(userKey('zoom-user', session.operatorId, prefix));
    }
  });

  await pipeline.exec();
  return true;
}

module.exports = {
  enabled,
  publishTranscriptSegment,
  publishParticipantEvent,
  recordRtmsSession,
  completeMeeting,
  deleteMeeting,
};
