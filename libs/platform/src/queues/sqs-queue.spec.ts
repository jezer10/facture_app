import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { SqsTaskQueue } from './sqs-queue';
import { sqsConfiguration } from './sqs-config';
import { DeferredTaskError, NonRetryableJobError } from './task-queue';

const config = sqsConfiguration({ AWS_REGION: 'us-east-1', SQS_ACCOUNT_ID: '123456789012' });
const wire = JSON.stringify({
  version: 1,
  name: 'issue',
  data: { eventId: 'event-1' },
  opts: { jobId: 'event-1', attempts: 4, backoff: { type: 'exponential', delay: 1000 } },
});
function message(count = 1): Message {
  return {
    MessageId: 'message-1',
    ReceiptHandle: 'receipt-1',
    Body: wire,
    Attributes: { ApproximateReceiveCount: String(count) },
  };
}
function setup(): {
  queue: SqsTaskQueue;
  send: jest.Mock<Promise<unknown>, [unknown]>;
  worker: { process: jest.Mock };
} {
  const send = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({});
  return {
    queue: new SqsTaskQueue({ send } as unknown as SQSClient, config, 'billing.sunat.commands.v1'),
    send,
    worker: { process: jest.fn().mockResolvedValue(undefined) },
  };
}
afterEach(() => jest.useRealTimers());
it('publishes a bounded envelope and delays reconciliation using SQS', async () => {
  const { queue, send } = setup();
  await queue.add('issue', { eventId: 'event-1' }, { jobId: 'event-1', delay: 30001 });
  const command = send.mock.calls[0]?.[0] as SendMessageCommand;
  expect(command.input.QueueUrl).toBe(
    'https://sqs.us-east-1.amazonaws.com/123456789012/facture-beta-billing-sunat-commands-v1',
  );
  expect(command.input.DelaySeconds).toBe(31);
  expect(JSON.parse(command.input.MessageBody ?? '') as unknown).toMatchObject({
    version: 1,
    opts: { jobId: 'event-1', attempts: 4 },
  });
  await expect(queue.add('issue', {}, { jobId: 'event-2', delay: 900001 })).rejects.toThrow(
    'delay',
  );
});
it('acknowledges only after successful durable processing', async () => {
  const { queue, send, worker } = setup();
  worker.process.mockImplementation(() => {
    expect(send).not.toHaveBeenCalled();
    return Promise.resolve();
  });
  await queue.handle(message(), worker);
  expect(worker.process).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'event-1', attemptsMade: 0 }),
  );
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteMessageCommand);
});
it('retains failed work and backs off using visibility rather than publishing another copy', async () => {
  const { queue, send, worker } = setup();
  worker.process.mockRejectedValue(new Error('transient'));
  await queue.handle(message(2), worker);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
  expect((send.mock.calls[0]?.[0] as ChangeMessageVisibilityCommand).input.VisibilityTimeout).toBe(
    2,
  );
});
it.each([new NonRetryableJobError('invalid'), new Error('exhausted')])(
  'preserves terminal failures in the DLQ before deletion',
  async (error) => {
    const { queue, send, worker } = setup();
    worker.process.mockRejectedValue(error);
    await queue.handle(message(4), worker);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(SendMessageCommand);
    expect((send.mock.calls[0]?.[0] as SendMessageCommand).input).toMatchObject({
      QueueUrl: queue.deadLetterUrl,
      MessageBody: wire,
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteMessageCommand);
  },
);
it('never deletes a message if the DLQ could not accept it', async () => {
  const { queue, send, worker } = setup();
  worker.process.mockRejectedValue(new NonRetryableJobError('bad'));
  send.mockRejectedValue(new Error('unavailable'));
  await expect(queue.handle(message(), worker)).rejects.toThrow('unavailable');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(SendMessageCommand);
});
it('quarantines malformed messages without invoking the domain', async () => {
  const { queue, send, worker } = setup();
  await queue.handle({ ...message(), Body: 'not-json' }, worker);
  expect(worker.process).not.toHaveBeenCalled();
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(SendMessageCommand);
});
it('leaves uncertain acknowledgements for idempotent redelivery, without sending to DLQ', async () => {
  const { queue, send, worker } = setup();
  send.mockRejectedValue(new Error('delete timeout'));
  await expect(queue.handle(message(), worker)).rejects.toThrow('delete timeout');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteMessageCommand);
});
it('defers an active command even on the last processing attempt', async () => {
  const { queue, send, worker } = setup();
  worker.process.mockRejectedValue(new DeferredTaskError(300));
  await queue.handle(message(4), worker);
  expect(send).toHaveBeenCalledTimes(1);
  expect((send.mock.calls[0]?.[0] as ChangeMessageVisibilityCommand).input.VisibilityTimeout).toBe(
    300,
  );
});
it('bounds domain attempt numbers after an acknowledgement was lost', async () => {
  const { queue, worker } = setup();
  await queue.handle(message(9), worker);
  expect(worker.process).toHaveBeenCalledWith(expect.objectContaining({ attemptsMade: 3 }));
});
it('extends visibility during long processing and stops heartbeats after acknowledgement', async () => {
  jest.useFakeTimers();
  const { queue, send, worker } = setup();
  let finish: (() => void) | undefined;
  worker.process.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = queue.handle(message(), worker);
  await jest.advanceTimersByTimeAsync(40001);
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
  finish?.();
  await pending;
  await jest.advanceTimersByTimeAsync(120000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteMessageCommand);
});
it('does not acknowledge a job after its visibility extension becomes uncertain', async () => {
  jest.useFakeTimers();
  const { queue, send, worker } = setup();
  send.mockRejectedValue(new Error('timeout'));
  let finish: (() => void) | undefined;
  worker.process.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = queue.handle(message(), worker);
  const assertion = expect(pending).rejects.toThrow('lease uncertain');
  await jest.advanceTimersByTimeAsync(40001);
  finish?.();
  await assertion;
  expect(send).toHaveBeenCalledTimes(1);
});
it('caches queue health checks to avoid billing an SQS request on every HTTP probe', async () => {
  const { queue, send } = setup();
  await queue.healthCheck();
  await queue.healthCheck();
  expect(send).toHaveBeenCalledTimes(1);
});
