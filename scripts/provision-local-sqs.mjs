import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

// Local only: this script cannot select an AWS endpoint or use real credentials.
const client = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:59324',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
try {
  for (const suffix of [
    'billing-sunat-commands-v1',
    'billing-sunat-results-v1',
    'billing-core-artifacts-v1',
    'billing-webhooks-v1',
  ]) {
    const name = `facture-local-${suffix}`;
    const dlq = await client.send(
      new CreateQueueCommand({
        QueueName: `${name}-dlq`,
        Attributes: { MessageRetentionPeriod: '1209600' },
      }),
    );
    const attributes = await client.send(
      new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
    );
    await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          VisibilityTimeout: '120',
          ReceiveMessageWaitTimeSeconds: '20',
          MessageRetentionPeriod: '345600',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: attributes.Attributes.QueueArn,
            maxReceiveCount: '20',
          }),
        },
      }),
    );
  }
  console.log('Four local SQS queues and their DLQs are ready. No AWS resources were created.');
} finally {
  client.destroy();
}
