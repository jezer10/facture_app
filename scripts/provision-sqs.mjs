#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  CreateQueueCommand,
} from '@aws-sdk/client-sqs';

const { values } = parseArgs({
  options: {
    profile: { type: 'string' },
    account: { type: 'string' },
    region: { type: 'string' },
    prefix: { type: 'string', default: 'facture-beta' },
    apply: { type: 'boolean', default: false },
  },
});
if (
  !/^\d{12}$/u.test(values.account ?? '') ||
  !/^us-east-1$/u.test(values.region ?? '') ||
  !/^[a-zA-Z0-9_-]{1,35}$/u.test(values.prefix)
)
  throw new Error(
    'Use [--profile <profile>] --account <12 digits> --region us-east-1 [--prefix facture-beta] [--apply]',
  );

const region = values.region;
const account = values.account;
const config = {
  ...(values.profile ? { profile: values.profile } : {}),
  region,
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
};
const sts = new STSClient({ ...config, endpoint: `https://sts.${region}.amazonaws.com` });
const sqs = new SQSClient({ ...config, endpoint: `https://sqs.${region}.amazonaws.com` });
const suffixes = [
  'billing-sunat-commands-v1',
  'billing-sunat-results-v1',
  'billing-core-artifacts-v1',
  'billing-webhooks-v1',
];
const expected = [];
for (const suffix of suffixes) {
  const name = `${values.prefix}-${suffix}`;
  const arn = `arn:aws:sqs:${region}:${account}:${name}`;
  const common = (resource) => ({
    SqsManagedSseEnabled: 'true',
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyInsecureTransport',
          Effect: 'Deny',
          Principal: '*',
          Action: 'sqs:*',
          Resource: resource,
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ],
    }),
  });
  expected.push({
    name: `${name}-dlq`,
    attributes: {
      ...common(`${arn}-dlq`),
      MessageRetentionPeriod: '1209600',
      RedriveAllowPolicy: JSON.stringify({ redrivePermission: 'byQueue', sourceQueueArns: [arn] }),
    },
  });
  expected.push({
    name,
    attributes: {
      ...common(arn),
      VisibilityTimeout: '120',
      ReceiveMessageWaitTimeSeconds: '20',
      MessageRetentionPeriod: '345600',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: `${arn}-dlq`, maxReceiveCount: 20 }),
    },
  });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function equivalent(key, actual, desired) {
  if (['Policy', 'RedrivePolicy', 'RedriveAllowPolicy'].includes(key)) {
    if (!actual) return false;
    return (
      JSON.stringify(canonical(JSON.parse(actual))) ===
      JSON.stringify(canonical(JSON.parse(desired)))
    );
  }
  return actual === desired;
}
async function lookup(queue) {
  let url;
  try {
    url = (
      await sqs.send(
        new GetQueueUrlCommand({ QueueName: queue.name, QueueOwnerAWSAccountId: account }),
      )
    ).QueueUrl;
  } catch (error) {
    if (['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue'].includes(error.name))
      return { exists: false };
    throw error;
  }
  if (!url) throw new Error(`SQS did not return a URL for ${queue.name}`);
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }),
  );
  const expectedArn = `arn:aws:sqs:${region}:${account}:${queue.name}`;
  if (Attributes.QueueArn !== expectedArn) throw new Error(`Unexpected queue owner: ${queue.name}`);
  const drift = Object.entries(queue.attributes)
    .filter(([key, desired]) => !equivalent(key, Attributes[key], desired))
    .map(([key]) => key);
  if (drift.length)
    throw new Error(
      `Existing queue differs; refusing to modify ${queue.name}: ${drift.join(', ')}`,
    );
  return { exists: true, url, arn: Attributes.QueueArn };
}
try {
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (identity.Account !== account)
    throw new Error(
      `Account mismatch: requested ${account}, authenticated ${identity.Account}. No queues changed.`,
    );
  // Complete the read-only preflight before performing any mutations.
  const states = await Promise.all(expected.map(lookup));
  const results = [];
  for (let i = 0; i < expected.length; i++) {
    const queue = expected[i];
    let state = states[i];
    let created = false;
    if (!state.exists && values.apply) {
      await sqs.send(
        new CreateQueueCommand({
          QueueName: queue.name,
          Attributes: queue.attributes,
          tags: {
            Project: 'facture',
            Environment: values.prefix,
            ManagedBy: 'facture-sqs-provisioner',
          },
        }),
      );
      state = await lookup(queue);
      if (!state.exists) throw new Error(`Creation not yet visible; rerun to verify ${queue.name}`);
      created = true;
    }
    results.push({
      name: queue.name,
      action: created ? 'created' : state.exists ? 'verified' : 'would-create',
      ...(state.url ? { url: state.url, arn: state.arn } : {}),
    });
  }
  console.log(
    JSON.stringify(
      { account, region, prefix: values.prefix, applied: values.apply, queues: results },
      null,
      2,
    ),
  );
} finally {
  sts.destroy();
  sqs.destroy();
}
