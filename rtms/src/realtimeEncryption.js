const crypto = require('crypto');
const { KMSClient, GenerateDataKeyCommand } = require('@aws-sdk/client-kms');

const ENCRYPTION_VERSION = 1;
const ENCRYPTION_ALG = 'AES-256-GCM';
const KMS_KEY_ID = process.env.REALTIME_KMS_KEY_ID || process.env.KMS_KEY_ID || '';

let kmsClient = null;
const dataKeyCache = new Map();

function enabled() {
  return !!KMS_KEY_ID;
}

function getKmsClient() {
  if (!kmsClient) {
    kmsClient = new KMSClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    });
  }
  return kmsClient;
}

function encryptionContext({ sessionId, meetingId, rtmsStreamId }) {
  return {
    app: 'arlo',
    purpose: 'realtime-valkey',
    sessionId: String(sessionId || ''),
    meetingId: String(meetingId || ''),
    rtmsStreamId: String(rtmsStreamId || ''),
  };
}

function cacheKey(session) {
  return session?.sessionId || `${session?.meetingId || ''}:${session?.rtmsStreamId || ''}`;
}

async function ensureSessionEncryption(session) {
  if (!enabled() || !session?.sessionId || !session?.meetingId || !session?.rtmsStreamId) {
    return null;
  }

  const key = cacheKey(session);
  const cached = dataKeyCache.get(key);
  if (cached) return cached.metadata;

  const context = encryptionContext(session);
  const result = await getKmsClient().send(new GenerateDataKeyCommand({
    KeyId: KMS_KEY_ID,
    KeySpec: 'AES_256',
    EncryptionContext: context,
  }));

  const plaintextKey = Buffer.from(result.Plaintext);
  const metadata = {
    version: ENCRYPTION_VERSION,
    alg: ENCRYPTION_ALG,
    keyId: result.KeyId || KMS_KEY_ID,
    encryptedDataKey: Buffer.from(result.CiphertextBlob).toString('base64'),
    encryptionContext: context,
  };

  dataKeyCache.set(key, { plaintextKey, metadata });
  return metadata;
}

function extractSensitivePayload(envelope) {
  if (envelope.type === 'transcript.segment' && envelope.segment) {
    const { speakerId, speakerLabel, text } = envelope.segment;
    const sensitiveSegment = {};
    if (speakerId !== undefined) sensitiveSegment.speakerId = speakerId;
    if (speakerLabel !== undefined) sensitiveSegment.speakerLabel = speakerLabel;
    if (text !== undefined) sensitiveSegment.text = text;

    return Object.keys(sensitiveSegment).length
      ? { segment: sensitiveSegment }
      : null;
  }

  if (envelope.type === 'participant.event' && envelope.event) {
    const { participantId, participantName } = envelope.event;
    const sensitiveEvent = {};
    if (participantId !== undefined) sensitiveEvent.participantId = participantId;
    if (participantName !== undefined) sensitiveEvent.participantName = participantName;

    return Object.keys(sensitiveEvent).length
      ? { event: sensitiveEvent }
      : null;
  }

  return null;
}

function redactSensitivePayload(envelope) {
  const redacted = { ...envelope };

  if (redacted.type === 'transcript.segment' && redacted.segment) {
    const { speakerId, speakerLabel, text, ...safeSegment } = redacted.segment;
    redacted.segment = safeSegment;
  }

  if (redacted.type === 'participant.event' && redacted.event) {
    const { participantId, participantName, ...safeEvent } = redacted.event;
    redacted.event = safeEvent;
  }

  return redacted;
}

function encryptJson(plaintextKey, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', plaintextKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);

  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

async function encryptEnvelope(envelope, session) {
  const sensitivePayload = extractSensitivePayload(envelope);
  if (!sensitivePayload) return envelope;

  const metadata = await ensureSessionEncryption(session);
  if (!metadata) return envelope;

  const cached = dataKeyCache.get(cacheKey(session));
  if (!cached?.plaintextKey) return envelope;

  return {
    ...redactSensitivePayload(envelope),
    encrypted: {
      ...metadata,
      ...encryptJson(cached.plaintextKey, sensitivePayload),
    },
  };
}

module.exports = {
  enabled,
  ensureSessionEncryption,
  encryptEnvelope,
};
