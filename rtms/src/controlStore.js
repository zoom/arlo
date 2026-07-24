const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const tableName = process.env.DYNAMODB_TABLE_NAME || '';
const activeTtlSeconds = parseInt(process.env.REALTIME_ACTIVE_TTL_SECONDS || '86400', 10);

let docClient = null;

function enabled() {
  return !!tableName;
}

function getClient() {
  if (!enabled()) return null;
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    }));
  }
  return docClient;
}

function nowIso() {
  return new Date().toISOString();
}

function expiresAt() {
  return Math.floor(Date.now() / 1000) + activeTtlSeconds;
}

function meetingPk(meetingId) {
  return `MEETING#${meetingId}`;
}

function streamSk(rtmsStreamId) {
  return `STREAM#${rtmsStreamId}`;
}

async function getItem(key) {
  const client = getClient();
  if (!client) return null;
  const result = await client.send(new GetCommand({
    TableName: tableName,
    Key: key,
  }));
  return result.Item || null;
}

async function getSession(meetingId, rtmsStreamId) {
  if (!meetingId || !rtmsStreamId) return null;
  return getItem({
    PK: meetingPk(meetingId),
    SK: streamSk(rtmsStreamId),
  });
}

async function getActiveSession(meetingId) {
  if (!meetingId) return null;
  const active = await getItem({
    PK: meetingPk(meetingId),
    SK: 'ACTIVE',
  });
  if (!active?.rtmsStreamId) return active;
  return getSession(meetingId, active.rtmsStreamId) || active;
}

async function putStartEvent({ meetingId, rtmsStreamId, payload, operatorId, realtimeCredential }) {
  const client = getClient();
  if (!client) return null;

  const timestamp = nowIso();
  const ttl = expiresAt();
  const base = {
    PK: meetingPk(meetingId),
    meetingId,
    rtmsStreamId,
    operatorId: operatorId || null,
    realtimeCredential: realtimeCredential || null,
    realtimeKeyPrefix: realtimeCredential?.keyPrefix || null,
    realtimeChannelPrefix: realtimeCredential?.channelPrefix || null,
    payload,
    status: 'launching',
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: ttl,
  };

  const sessionItem = {
    ...base,
    SK: streamSk(rtmsStreamId),
  };
  const activeItem = {
    ...base,
    SK: 'ACTIVE',
  };

  await client.send(new PutCommand({
    TableName: tableName,
    Item: sessionItem,
  }));
  await client.send(new PutCommand({
    TableName: tableName,
    Item: activeItem,
  }));
  return sessionItem;
}

async function updateSession(meetingId, rtmsStreamId, attributes = {}) {
  const client = getClient();
  if (!client || !meetingId || !rtmsStreamId) return null;

  const entries = Object.entries({
    ...attributes,
    updatedAt: nowIso(),
    expiresAt: expiresAt(),
  });
  const names = {};
  const values = {};
  const assignments = entries.map(([key, value], index) => {
    const name = `#n${index}`;
    const val = `:v${index}`;
    names[name] = key;
    values[val] = value;
    return `${name} = ${val}`;
  });

  const params = {
    TableName: tableName,
    Key: {
      PK: meetingPk(meetingId),
      SK: streamSk(rtmsStreamId),
    },
    UpdateExpression: `SET ${assignments.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  };

  const result = await client.send(new UpdateCommand(params));

  await client.send(new UpdateCommand({
    ...params,
    Key: {
      PK: meetingPk(meetingId),
      SK: 'ACTIVE',
    },
    ReturnValues: 'NONE',
  })).catch(() => {});

  return result.Attributes || null;
}

async function markTaskStarted(meetingId, rtmsStreamId, taskArn) {
  return updateSession(meetingId, rtmsStreamId, {
    taskArn,
    status: 'running',
  });
}

async function markLaunchFailed(meetingId, rtmsStreamId, reason) {
  return updateSession(meetingId, rtmsStreamId, {
    status: 'launch_failed',
    failureReason: reason,
  });
}

async function markWorkerCompleted(meetingId, rtmsStreamId, reason) {
  return updateSession(meetingId, rtmsStreamId, {
    status: 'completed',
    completedAt: nowIso(),
    completionReason: reason || null,
  });
}

async function deleteSession(meetingId, rtmsStreamId) {
  const client = getClient();
  if (!client || !meetingId) return false;

  const active = await getItem({
    PK: meetingPk(meetingId),
    SK: 'ACTIVE',
  });
  const streamId = rtmsStreamId || active?.rtmsStreamId;

  if (streamId) {
    await client.send(new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: meetingPk(meetingId),
        SK: streamSk(streamId),
      },
    }));
  }

  if (!active?.rtmsStreamId || !streamId || active.rtmsStreamId === streamId) {
    await client.send(new DeleteCommand({
      TableName: tableName,
      Key: {
        PK: meetingPk(meetingId),
        SK: 'ACTIVE',
      },
    }));
  }

  return true;
}

module.exports = {
  enabled,
  getActiveSession,
  getSession,
  putStartEvent,
  markTaskStarted,
  markLaunchFailed,
  markWorkerCompleted,
  deleteSession,
};
