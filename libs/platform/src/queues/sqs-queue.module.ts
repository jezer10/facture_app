import { Global, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { sqsConfiguration } from './sqs-config';
import { SqsTaskQueue } from './sqs-queue';
import { queueToken, TASK_PROCESSOR, TaskWorker } from './task-queue';

@Injectable()
class SqsRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly abort = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private readonly queues = new Map<string, SqsTaskQueue>();
  private readonly config = sqsConfiguration();
  private readonly client = new SQSClient(this.config.client);
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}
  queue(name: string): SqsTaskQueue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new SqsTaskQueue(this.client, this.config, name);
      this.queues.set(name, queue);
    }
    return queue;
  }
  async onApplicationBootstrap(): Promise<void> {
    const started = new Set<string>();
    const consumers: { queue: SqsTaskQueue; worker: TaskWorker; concurrency: number }[] = [];
    for (const provider of this.discovery.getProviders()) {
      const instance: unknown = provider.instance;
      if (!(instance instanceof TaskWorker)) continue;
      const metadata = this.reflector.get<{ name: string; concurrency: number }>(
        TASK_PROCESSOR,
        instance.constructor,
      );
      if (!metadata) throw new Error('Task worker is missing queue metadata');
      if (started.has(metadata.name))
        throw new Error(`Duplicate consumer registration: ${metadata.name}`);
      started.add(metadata.name);
      const queue = this.queue(metadata.name);
      consumers.push({ queue, worker: instance, concurrency: metadata.concurrency });
    }
    await Promise.all(consumers.map(({ queue }) => queue.healthCheck()));
    for (const { queue, worker, concurrency } of consumers) {
      this.loops.push(queue.poll(worker, concurrency, this.abort.signal));
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.loops);
    this.client.destroy();
  }
}
@Global()
@Module({ imports: [DiscoveryModule], providers: [SqsRuntime], exports: [SqsRuntime] })
class SqsRuntimeModule {}
@Module({})
export class SqsQueueModule {
  static forRoot(): DynamicModule {
    return { module: SqsQueueModule, imports: [SqsRuntimeModule] };
  }
  static registerQueue(...queues: { name: string }[]): DynamicModule {
    const providers = queues.map(({ name }) => ({
      provide: queueToken(name),
      useFactory: (runtime: SqsRuntime): SqsTaskQueue => runtime.queue(name),
      inject: [SqsRuntime],
    }));
    return {
      module: SqsQueueModule,
      imports: [SqsRuntimeModule],
      providers,
      exports: providers.map((provider) => provider.provide),
    };
  }
}
