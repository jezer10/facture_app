import type { SQSClientConfig } from '@aws-sdk/client-sqs';

export interface SqsConfiguration {
  client: SQSClientConfig;
  baseUrl: string;
  prefix: string;
  visibilitySeconds: number;
}

export function sqsConfiguration(env: NodeJS.ProcessEnv = process.env): SqsConfiguration {
  const region = env.AWS_REGION;
  const account = env.SQS_ACCOUNT_ID;
  const prefix = env.SQS_QUEUE_PREFIX ?? 'facture-beta';
  if (!region || !/^[a-z]{2}(-[a-z]+)+-\d$/u.test(region))
    throw new Error('AWS_REGION is required for SQS');
  if (!account || !/^\d{12}$/u.test(account)) throw new Error('SQS_ACCOUNT_ID must have 12 digits');
  if (!/^[a-zA-Z0-9_-]{1,35}$/u.test(prefix)) throw new Error('Invalid SQS_QUEUE_PREFIX');
  const endpoint = env.SQS_ENDPOINT;
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      env.NODE_ENV === 'production' ||
      url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', 'sqs'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('SQS_ENDPOINT is restricted to the local development emulator');
  }
  return {
    client: {
      region,
      maxAttempts: 3,
      ...(endpoint
        ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
        : {}),
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    },
    baseUrl: `${endpoint?.replace(/\/$/u, '') ?? `https://sqs.${region}.amazonaws.com`}/${account}`,
    prefix,
    visibilitySeconds: 120,
  };
}
export function sqsQueueUrl(config: SqsConfiguration, name: string): string {
  if (!/^[a-zA-Z0-9._-]+$/u.test(name)) throw new Error('Invalid logical queue name');
  return `${config.baseUrl}/${config.prefix}-${name.replaceAll('.', '-')}`;
}
