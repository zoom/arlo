const crypto = require('crypto');
const { KMSClient, DecryptCommand } = require('@aws-sdk/client-kms');

const ENCRYPTION_ALG = 'AES-256-GCM';

let kmsClient = null;
const dataKeyCache = new Map();

function getKmsClient() {
  if (!kmsClient) {
    kmsClient = new KMSClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    });
  }
  return kmsClient;
}

function encryptionCacheKey(encrypted) {
  const context = encrypted?.encryptionContext || {};
  return [
    encrypted?.encryptedDataKey || '',
    context.sessionId || '',
    context.meetingId || '',
    context.rtmsStreamId || '',
  ].join(':');
}

async function getPlaintextKey(encrypted) {
  if (!encrypted?.encryptedDataKey) return null;

  const key = encryptionCacheKey(encrypted);
  const cached = dataKeyCache.get(key);
  if (cached) return cached;

  const result = await getKmsClient().send(new DecryptCommand({
    CiphertextBlob: Buffer.from(encrypted.encryptedDataKey, 'base64'),
    EncryptionContext: encrypted.encryptionContext || {},
  }));

  const plaintextKey = Buffer.from(result.Plaintext);
  dataKeyCache.set(key, plaintextKey);
  return plaintextKey;
}

function decryptJson(plaintextKey, encrypted) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    plaintextKey,
    Buffer.from(encrypted.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

function mergeSensitivePayload(envelope, sensitivePayload) {
  const decrypted = { ...envelope };
  delete decrypted.encrypted;

  if (sensitivePayload.segment) {
    decrypted.segment = {
      ...(decrypted.segment || {}),
      ...sensitivePayload.segment,
    };
  }

  if (sensitivePayload.event) {
    decrypted.event = {
      ...(decrypted.event || {}),
      ...sensitivePayload.event,
    };
  }

  return decrypted;
}

async function decryptEnvelope(envelope) {
  if (!envelope?.encrypted) return envelope;
  const encrypted = envelope.encrypted;
  if (encrypted.alg !== ENCRYPTION_ALG) {
    throw new Error(`Unsupported realtime envelope encryption alg: ${encrypted.alg}`);
  }

  const plaintextKey = await getPlaintextKey(encrypted);
  const sensitivePayload = decryptJson(plaintextKey, encrypted);
  return mergeSensitivePayload(envelope, sensitivePayload);
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
  const encryptedMetadata = session?.realtimeEncryption;
  if (!sensitivePayload || !encryptedMetadata?.encryptedDataKey) return envelope;

  const plaintextKey = await getPlaintextKey(encryptedMetadata);
  return {
    ...redactSensitivePayload(envelope),
    encrypted: {
      ...encryptedMetadata,
      ...encryptJson(plaintextKey, sensitivePayload),
    },
  };
}

function forgetSession(sessionId) {
  if (!sessionId) return;
  for (const key of dataKeyCache.keys()) {
    if (key.includes(`:${sessionId}:`)) {
      dataKeyCache.delete(key);
    }
  }
}

module.exports = {
  decryptEnvelope,
  encryptEnvelope,
  forgetSession,
};
