const { ECSClient, RunTaskCommand, StopTaskCommand } = require('@aws-sdk/client-ecs');

let ecsClient = null;

function getClient() {
  if (!ecsClient) {
    ecsClient = new ECSClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    });
  }
  return ecsClient;
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function enabled() {
  return !!(
    process.env.ECS_CLUSTER_ARN &&
    process.env.RTMS_WORKER_TASK_DEFINITION_ARN &&
    process.env.RTMS_WORKER_CONTAINER_NAME &&
    process.env.RTMS_WORKER_SUBNET_IDS &&
    process.env.RTMS_WORKER_SECURITY_GROUP_IDS
  );
}

function shortStartedBy(meetingId) {
  return `arlo-rtms-${Buffer.from(String(meetingId)).toString('base64url').slice(0, 24)}`;
}

async function runWorker({ meetingId, rtmsStreamId }) {
  if (!enabled()) {
    throw new Error('RTMS worker launcher is not configured');
  }

  const environment = [
    { name: 'RTMS_WORKER_MODE', value: 'single-stream' },
    { name: 'RTMS_WORKER_MEETING_ID', value: String(meetingId) },
    { name: 'RTMS_WORKER_STREAM_ID', value: String(rtmsStreamId) },
  ];

  const command = new RunTaskCommand({
    cluster: process.env.ECS_CLUSTER_ARN,
    taskDefinition: process.env.RTMS_WORKER_TASK_DEFINITION_ARN,
    launchType: 'FARGATE',
    count: 1,
    platformVersion: 'LATEST',
    startedBy: shortStartedBy(meetingId),
    enableExecuteCommand: false,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: csv(process.env.RTMS_WORKER_SUBNET_IDS),
        securityGroups: csv(process.env.RTMS_WORKER_SECURITY_GROUP_IDS),
        assignPublicIp: process.env.RTMS_WORKER_ASSIGN_PUBLIC_IP || 'ENABLED',
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: process.env.RTMS_WORKER_CONTAINER_NAME,
          environment,
        },
      ],
    },
    tags: [
      { key: 'Application', value: 'arlo' },
      { key: 'Component', value: 'rtms-worker' },
      { key: 'GroupName', value: process.env.GROUP_NAME || 'arlo-assistant' },
      { key: 'Owner', value: process.env.OWNER || 'arlo-assistant' },
      { key: 'MeetingId', value: String(meetingId).slice(0, 128) },
      { key: 'RtmsStreamId', value: String(rtmsStreamId).slice(0, 128) },
    ],
  });

  const result = await getClient().send(command);
  if (result.failures?.length) {
    const reason = result.failures.map((failure) => failure.reason || failure.arn).join('; ');
    throw new Error(`ECS RunTask failed: ${reason}`);
  }

  const taskArn = result.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error('ECS RunTask returned no task ARN');
  }
  return taskArn;
}

async function stopWorker(taskArn, reason = 'RTMS meeting stopped') {
  if (!taskArn) return false;
  await getClient().send(new StopTaskCommand({
    cluster: process.env.ECS_CLUSTER_ARN || process.env.ECS_CLUSTER_NAME,
    task: taskArn,
    reason,
  }));
  return true;
}

module.exports = {
  enabled,
  runWorker,
  stopWorker,
};
