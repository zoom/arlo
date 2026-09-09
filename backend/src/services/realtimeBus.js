const os = require('os');
const Redis = require('ioredis');
const config = require('../config');
const realtimeEncryption = require('./realtimeEncryption');

const INSTANCE_ID = `${os.hostname()}-${process.pid}`;
let publisher = null;
let subscriber = null;
let ready = false;
let initPromise = null;
let messageHandler = null;

function enabled() {
  return !!config.redisUrl;
}

function encodeId(value) {
  return Buffer.from(String(value || 'unknown')).toString('base64url');
}

function createClient(role) {
  if (!enabled()) return null;
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    retryStrategy(times) {
      return Math.min(times * 250, 5000);
    },
    connectionName: `arlo-${role}-${INSTANCE_ID}`.slice(0, 64),
  });
}

function channelPatterns() {
  return config.realtimeChannelPatterns?.length
    ? config.realtimeChannelPatterns
    : [
      `${config.realtimeChannelPrefix}:meeting:*`,
      `${config.realtimeChannelPrefix}:m:*:meeting:*`,
    ];
}

function keysForSession(sessionId, prefix = config.realtimeKeyPrefix) {
  return {
    session: `${prefix}:session:${sessionId}`,
    events: `${prefix}:session:${sessionId}:events`,
  };
}

function aliasKey(type, value, prefix = config.realtimeKeyPrefix) {
  return `${prefix}:alias:${type}:${encodeId(value)}`;
}

function userKey(type, value, prefix = config.realtimeKeyPrefix) {
  return `${prefix}:${type}:${encodeId(value)}:active_session`;
}

function channelForMeeting(meetingId, prefix = config.realtimeChannelPrefix) {
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

function sessionMatchesIdentity(session, metadata = {}, { allowUnclaimed = false } = {}) {
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

async function connectIfNeeded() {
  if (!enabled()) return false;
  if (ready) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    publisher = publisher || createClient('pub');
    subscriber = subscriber || createClient('sub');

    publisher.on('error', (err) => console.warn('Valkey publisher error:', err.message));
    subscriber.on('error', (err) => console.warn('Valkey subscriber error:', err.message));

    await publisher.connect();
    await subscriber.connect();
    await subscriber.psubscribe(...channelPatterns());

    subscriber.on('pmessage', async (_pattern, _channel, raw) => {
      if (!messageHandler) return;
      try {
        const envelope = JSON.parse(raw);
        const decryptedEnvelope = await realtimeEncryption.decryptEnvelope(envelope);
        messageHandler(decryptedEnvelope);
      } catch (error) {
        console.warn('Valkey message parse failed:', error.message);
      }
    });

    ready = true;
    console.log(`Valkey realtime bus connected (${channelPatterns().join(', ')})`);
    return true;
  })().catch((error) => {
    ready = false;
    initPromise = null;
    console.warn('Valkey realtime bus unavailable:', error.message);
    return false;
  });

  return initPromise;
}

async function initRealtimeBus(handler) {
  messageHandler = handler;
  return connectIfNeeded();
}

async function getClient() {
  const ok = await connectIfNeeded();
  return ok ? publisher : null;
}

async function readJson(key) {
  const client = await getClient();
  if (!client) return null;
  const value = await client.get(key);
  return value ? JSON.parse(value) : null;
}

async function readSessionByAlias(type, value) {
  const client = await getClient();
  if (!client || !value) return null;
  const sessionId = await client.get(aliasKey(type, value));
  return sessionId ? readJson(keysForSession(sessionId).session) : null;
}

async function resolveSession({ meetingId, sessionId, clientSessionId, rtmsStreamId, appUserId, zoomUserId, operatorId } = {}) {
  const client = await getClient();
  if (!client) return null;

  const identity = { appUserId, zoomUserId, operatorId };
  const hasIdentity = !!(appUserId || zoomUserId || operatorId);
  const streamId = rtmsStreamId || sessionId || null;
  const candidates = [];
  if (appUserId) candidates.push(userKey('app-user', appUserId));
  if (zoomUserId) candidates.push(userKey('zoom-user', zoomUserId));
  if (operatorId && operatorId !== zoomUserId) candidates.push(userKey('zoom-user', operatorId));
  if (meetingId && streamId) candidates.push(aliasKey('meeting-stream', meetingStreamAliasValue(meetingId, streamId)));
  if (streamId) candidates.push(aliasKey('rtms-stream', streamId));
  if (!streamId && sessionId) candidates.push(aliasKey('client-session', sessionId));
  if (!streamId && clientSessionId) candidates.push(aliasKey('client-session', clientSessionId));
  if (!streamId && meetingId) candidates.push(aliasKey('meeting', meetingId));

  for (const key of candidates) {
    const resolved = await client.get(key);
    if (resolved) {
      const session = await readJson(keysForSession(resolved).session);
      if (!hasIdentity || sessionMatchesIdentity(session, identity)) {
        return session;
      }
    }
  }
  return null;
}

async function upsertSession(metadata = {}) {
  const client = await getClient();
  if (!client) return null;

  const existing = await resolveSession(metadata);
  const sessionId = existing?.sessionId ||
    metadata.sessionId ||
    defaultSessionId(metadata.rtmsMeetingId || metadata.meetingId, metadata.rtmsStreamId);
  const now = Date.now();
  const session = {
    ...(existing || {}),
    ...metadata,
    sessionId,
    realtimeKeyPrefix: metadata.realtimeKeyPrefix || existing?.realtimeKeyPrefix || config.realtimeKeyPrefix,
    realtimeChannelPrefix: metadata.realtimeChannelPrefix || existing?.realtimeChannelPrefix || config.realtimeChannelPrefix,
    updatedAt: now,
    createdAt: existing?.createdAt || now,
  };

  const ttl = metadata.status === 'completed'
    ? config.realtimeCompletedTtlSeconds
    : config.realtimeActiveTtlSeconds;
  const sessionKeys = keysForSession(sessionId);
  const pipeline = client.pipeline();
  pipeline.set(sessionKeys.session, JSON.stringify(session), 'EX', ttl);

  const aliases = [
    ['meeting-stream', session.meetingId && session.rtmsStreamId ? meetingStreamAliasValue(session.meetingId, session.rtmsStreamId) : null],
    ['meeting-stream', session.rtmsMeetingId && session.rtmsStreamId ? meetingStreamAliasValue(session.rtmsMeetingId, session.rtmsStreamId) : null],
    ['meeting-stream', session.sdkMeetingId && session.rtmsStreamId ? meetingStreamAliasValue(session.sdkMeetingId, session.rtmsStreamId) : null],
    ['meeting', session.meetingId],
    ['meeting', session.sdkMeetingId],
    ['meeting', session.rtmsMeetingId],
    ['client-session', session.clientSessionId],
    ['rtms-stream', session.rtmsStreamId],
  ];
  aliases.forEach(([type, value]) => {
    if (value) pipeline.set(aliasKey(type, value), sessionId, 'EX', ttl);
  });
  if (session.appUserId) pipeline.set(userKey('app-user', session.appUserId), sessionId, 'EX', ttl);
  if (session.zoomUserId) pipeline.set(userKey('zoom-user', session.zoomUserId), sessionId, 'EX', ttl);
  pipeline.expire(sessionKeys.events, ttl);

  await pipeline.exec();
  return session;
}

async function appendEnvelope(session, envelope) {
  const client = await getClient();
  if (!client || !session?.sessionId) return false;

  const ttl = envelope.type === 'meeting.status' && envelope.status === 'rtms_stopped'
    ? config.realtimeCompletedTtlSeconds
    : config.realtimeActiveTtlSeconds;
  const eventPrefix = session.realtimeKeyPrefix || config.realtimeKeyPrefix;
  const publishPrefix = session.realtimeChannelPrefix || config.realtimeChannelPrefix;
  const sessionKeys = keysForSession(session.sessionId, eventPrefix);
  const envelopeForStorage = await realtimeEncryption.encryptEnvelope(envelope, session);
  const serialized = JSON.stringify(envelopeForStorage);
  await client
    .pipeline()
    .rpush(sessionKeys.events, serialized)
    .ltrim(sessionKeys.events, -config.realtimeReplayLimit, -1)
    .expire(sessionKeys.events, ttl)
    .publish(channelForMeeting(envelope.meetingId, publishPrefix), serialized)
    .exec();
  return true;
}

async function publishEnvelope(type, meetingId, payload = {}, metadata = {}) {
  if (!meetingId) return false;
  const baseSession = await upsertSession({
    ...metadata,
    meetingId,
    rtmsMeetingId: metadata.rtmsMeetingId || meetingId,
  });
  if (!baseSession) return false;

  const envelope = {
    type,
    meetingId,
    sessionId: baseSession.sessionId,
    sdkMeetingId: baseSession.sdkMeetingId || null,
    rtmsMeetingId: baseSession.rtmsMeetingId || meetingId,
    rtmsStreamId: baseSession.rtmsStreamId || null,
    clientSessionId: baseSession.clientSessionId || null,
    realtimeKeyPrefix: baseSession.realtimeKeyPrefix || null,
    realtimeChannelPrefix: baseSession.realtimeChannelPrefix || null,
    appUserId: baseSession.appUserId || null,
    zoomUserId: baseSession.zoomUserId || null,
    operatorId: baseSession.operatorId || null,
    zoomMeetingNumber: baseSession.zoomMeetingNumber || null,
    originInstanceId: INSTANCE_ID,
    publishedAt: Date.now(),
    ...payload,
  };

  return appendEnvelope(baseSession, envelope);
}

async function publishTranscriptSegment(meetingId, segment, metadata) {
  return publishEnvelope('transcript.segment', meetingId, { segment }, metadata);
}

async function publishParticipantEvent(meetingId, event, metadata) {
  return publishEnvelope('participant.event', meetingId, { event }, metadata);
}

async function publishMeetingStatus(meetingId, status, metadata = {}) {
  return publishEnvelope('meeting.status', meetingId, { status }, { ...metadata, status });
}

async function registerClientSession(metadata = {}) {
  const existingForMeeting = await readSessionByAlias('meeting', metadata.meetingId || metadata.sdkMeetingId);
  if (existingForMeeting && !sessionMatchesIdentity(existingForMeeting, metadata)) {
    console.warn(
      `Rejected client realtime session for meeting "${metadata.meetingId || metadata.sdkMeetingId}" because token identity does not match active RTMS session`
    );
    return null;
  }

  return upsertSession({
    ...metadata,
    clientSessionId: metadata.clientSessionId || metadata.sessionId,
    sdkMeetingId: metadata.sdkMeetingId || metadata.meetingId,
    meetingId: metadata.meetingId || metadata.sdkMeetingId,
    status: metadata.status || 'client_connected',
  });
}

async function replaySession(sessionId, send) {
  const client = await getClient();
  if (!client || !sessionId) return 0;
  const globalSession = await readJson(keysForSession(sessionId).session);
  const eventPrefix = globalSession?.realtimeKeyPrefix || config.realtimeKeyPrefix;
  const events = await client.lrange(keysForSession(sessionId, eventPrefix).events, -config.realtimeReplayLimit, -1);
  let count = 0;
  for (const raw of events) {
    try {
      const envelope = JSON.parse(raw);
      const decryptedEnvelope = await realtimeEncryption.decryptEnvelope(envelope);
      send(decryptedEnvelope);
      count++;
    } catch {
      // Ignore malformed historical entries.
    }
  }
  return count;
}

async function completeMeeting(meetingId) {
  const client = await getClient();
  if (!client || !meetingId) return false;
  const session = await resolveSession({ meetingId });
  if (!session) return false;

  const completed = await upsertSession({ ...session, status: 'completed', completedAt: Date.now() });
  const ttl = config.realtimeCompletedTtlSeconds;
  const pipeline = client.pipeline();
  const prefixes = new Set([config.realtimeKeyPrefix, completed.realtimeKeyPrefix].filter(Boolean));
  prefixes.forEach((prefix) => {
    const sessionKeys = keysForSession(completed.sessionId, prefix);
    pipeline.expire(sessionKeys.session, ttl);
    pipeline.expire(sessionKeys.events, ttl);
    [
      ['meeting', completed.meetingId],
      ['meeting', completed.sdkMeetingId],
      ['meeting', completed.rtmsMeetingId],
      ['meeting-stream', completed.meetingId && completed.rtmsStreamId ? meetingStreamAliasValue(completed.meetingId, completed.rtmsStreamId) : null],
      ['meeting-stream', completed.sdkMeetingId && completed.rtmsStreamId ? meetingStreamAliasValue(completed.sdkMeetingId, completed.rtmsStreamId) : null],
      ['meeting-stream', completed.rtmsMeetingId && completed.rtmsStreamId ? meetingStreamAliasValue(completed.rtmsMeetingId, completed.rtmsStreamId) : null],
      ['client-session', completed.clientSessionId],
      ['rtms-stream', completed.rtmsStreamId],
    ].forEach(([type, value]) => {
      if (value) pipeline.expire(aliasKey(type, value, prefix), ttl);
    });
    if (completed.appUserId) pipeline.expire(userKey('app-user', completed.appUserId, prefix), ttl);
    if (completed.zoomUserId) pipeline.expire(userKey('zoom-user', completed.zoomUserId, prefix), ttl);
  });
  await pipeline.exec();
  return true;
}

async function deleteMeeting(meetingId, rtmsStreamId) {
  const client = await getClient();
  if (!client || !meetingId) return false;
  const session = await resolveSession({ meetingId, rtmsStreamId });
  const pipeline = client.pipeline();

  const prefixes = new Set([config.realtimeKeyPrefix, session?.realtimeKeyPrefix].filter(Boolean));
  prefixes.forEach((prefix) => {
    if (session?.sessionId) {
      const sessionKeys = keysForSession(session.sessionId, prefix);
      pipeline.del(sessionKeys.session);
      pipeline.del(sessionKeys.events);
      realtimeEncryption.forgetSession(session.sessionId);
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

function isReady() {
  return ready;
}

module.exports = {
  INSTANCE_ID,
  enabled,
  isReady,
  initRealtimeBus,
  publishTranscriptSegment,
  publishParticipantEvent,
  publishMeetingStatus,
  registerClientSession,
  resolveSession,
  replaySession,
  completeMeeting,
  deleteMeeting,
};
