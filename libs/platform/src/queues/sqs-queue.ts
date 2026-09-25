import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { DeferredTaskError, NonRetryableJobError } from './task-queue';
import type { TaskJob, TaskOptions, TaskQueue, TaskWorker } from './task-queue';
import { sqsQueueUrl } from './sqs-config';
import type { SqsConfiguration } from './sqs-config';

const wireSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(100),
    data: z.unknown(),
    opts: z
      .object({
        jobId: z.string().min(1).max(128),
        attempts: z.number().int().min(1).max(20),
        backoff: z.object({
          type: z.literal('exponential'),
          delay: z.number().int().min(0).max(900_000),
        }),
      })
      .strict(),
  })
  .strict();

// SQS standard queues deliver at least once. Durable inbox/ledger records, not
// SQS message IDs, decide whether fiscal side effects have already happened.
export class SqsTaskQueue<T = unknown> implements TaskQueue<T> {
  readonly url: string;
  readonly deadLetterUrl: string;
  private readonly logger = new Logger(SqsTaskQueue.name);
  private lastHealthyAt = 0;
  constructor(
    private readonly client: SQSClient,
    private readonly config: SqsConfiguration,
    name: string,
  ) {
    this.url = sqsQueueUrl(config, name);
    this.deadLetterUrl = `${this.url}-dlq`;
  }

  async add(name: string, data: T, options: TaskOptions): Promise<void> {
    const wire = wireSchema.parse({
      version: 1,
      name,
      data,
      opts: {
        jobId: options.jobId,
        attempts: options.attempts ?? 4,
        backoff: options.backoff ?? { type: 'exponential', delay: 1000 },
      },
    });
    const delay = options.delay ?? 0;
    if (!Number.isFinite(delay) || delay < 0 || delay > 900_000)
      throw new Error('SQS delay must be 0–900000ms');
    const body = JSON.stringify(wire);
    if (Buffer.byteLength(body) > 256 * 1024)
      throw new Error('Queue payload too large; store content in object storage');
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.url,
        MessageBody: body,
        DelaySeconds: Math.ceil(delay / 1000),
      }),
    );
  }

  async healthCheck(): Promise<void> {
    if (Date.now() - this.lastHealthyAt < 300_000) return;
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: this.url, AttributeNames: ['QueueArn'] }),
    );
    this.lastHealthyAt = Date.now();
  }

  async poll(worker: TaskWorker, concurrency: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.url,
            WaitTimeSeconds: 20,
            MaxNumberOfMessages: Math.min(10, concurrency),
            VisibilityTimeout: this.config.visibilitySeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: signal },
        );
        this.lastHealthyAt = Date.now();
        const results = await Promise.allSettled(
          (response.Messages ?? []).map((message) => this.handle(message, worker)),
        );
        if (results.some((result) => result.status === 'rejected'))
          throw new Error('SQS message acknowledgement failed');
      } catch {
        if (!signal.aborted) {
          this.lastHealthyAt = 0;
          this.logger.error({ code: 'SQS_POLL_OR_ACK_FAILED', queue: this.url });
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            timer.unref();
          });
        }
      }
    }
  }

  async handle(message: Message, worker: TaskWorker): Promise<void> {
    const receipt = message.ReceiptHandle;
    if (!receipt) throw new Error('SQS message missing receipt handle');
    let job: TaskJob;
    try {
      const parsed = wireSchema.parse(JSON.parse(message.Body ?? ''));
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount);
      if (!Number.isInteger(receiveCount) || receiveCount < 1)
        throw new Error('Invalid receive count');
      job = {
        id: parsed.opts.jobId,
        name: parsed.name,
        data: parsed.data,
        opts: parsed.opts,
        attemptsMade: Math.min(receiveCount, parsed.opts.attempts) - 1,
      };
    } catch {
      await this.deadLetter(message);
      return;
    }
    let heartbeat: Promise<unknown> | undefined;
    let leaseLost = false;
    const timer = setInterval(
      () => {
        if (heartbeat) return;
        heartbeat = this.changeVisibility(receipt, this.config.visibilitySeconds)
          .catch(() => {
            leaseLost = true;
            this.logger.error({ code: 'SQS_VISIBILITY_EXTENSION_FAILED', eventId: job.id });
          })
          .finally(() => {
            heartbeat = undefined;
          });
      },
      (this.config.visibilitySeconds * 1000) / 3,
    );
    timer.unref();
    let failed = false;
    let failure: unknown;
    try {
      await worker.process(job);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
    // An uncertain lease is left for redelivery; inbox/ledger idempotency protects side effects.
    if (leaseLost) throw new Error('SQS lease uncertain');
    if (!failed) {
      await this.client.send(
        new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: receipt }),
      );
    } else if (failure instanceof DeferredTaskError) {
      await this.changeVisibility(receipt, Math.min(900, Math.max(1, failure.delaySeconds)));
    } else if (
      failure instanceof NonRetryableJobError ||
      job.attemptsMade + 1 >= (job.opts.attempts ?? 4)
    ) {
      await this.deadLetter(message);
    } else {
      const delay = Math.min(
        900,
        Math.ceil(((job.opts.backoff?.delay ?? 1000) * 2 ** Math.min(job.attemptsMade, 20)) / 1000),
      );
      await this.changeVisibility(receipt, delay);
      this.logger.warn({ code: 'SQS_JOB_RETRY', eventId: job.id, attempt: job.attemptsMade + 1 });
    }
  }

  private async changeVisibility(receipt: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.url,
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds,
      }),
    );
  }
  private async deadLetter(message: Message): Promise<void> {
    // Publish first, acknowledge second: a failed DLQ send must never discard a task.
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.deadLetterUrl,
        MessageBody: message.Body || '{"invalid":true}',
      }),
    );
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: message.ReceiptHandle }),
    );
    this.logger.error({
      code: 'SQS_JOB_DEAD_LETTERED',
      messageId: message.MessageId,
      queue: this.url,
    });
  }
}
