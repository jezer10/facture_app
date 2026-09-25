import { Inject, SetMetadata } from '@nestjs/common';

export interface TaskOptions {
  jobId: string;
  attempts?: number;
  delay?: number;
  backoff?: { type: 'exponential'; delay: number };
}
export interface TaskJob<T = unknown> {
  readonly id: string;
  readonly name: string;
  data: T;
  readonly opts: TaskOptions;
  readonly attemptsMade: number;
}
export interface TaskQueue<T = unknown> {
  add(name: string, data: T, options: TaskOptions): Promise<void>;
  healthCheck(): Promise<void>;
}
export abstract class TaskWorker {
  abstract process(job: TaskJob): Promise<void>;
}
export class NonRetryableJobError extends Error {}
export class DeferredTaskError extends Error {
  constructor(readonly delaySeconds: number) {
    super('TASK_ALREADY_PROCESSING');
  }
}
export const TASK_PROCESSOR = 'facture:sqs:processor';
export const queueToken = (name: string): string => `facture:sqs:${name}`;
export const InjectTaskQueue = (name: string): ParameterDecorator => Inject(queueToken(name));
export const QueueProcessor = (name: string, options: { concurrency: number }): ClassDecorator =>
  SetMetadata(TASK_PROCESSOR, { name, ...options });
