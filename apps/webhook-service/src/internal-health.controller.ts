import { WEBHOOKS_QUEUE } from '@app/contracts';
import { WEBHOOK_REPOSITORY, type WebhookRepository } from '@app/webhooks';
import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Queue } from 'bullmq';

@Controller('internal/health')
export class InternalHealthController {
  constructor(
    @Inject(WEBHOOK_REPOSITORY)
    private readonly repository: WebhookRepository,
    @InjectQueue(WEBHOOKS_QUEUE)
    private readonly queue: Queue,
  ) {}

  @Get('live')
  live(): Readonly<{ service: string; status: string }> {
    return { service: 'webhook-service', status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<Readonly<{ service: string; status: string }>> {
    try {
      await Promise.all([this.repository.checkHealth(), this.queue.getJobCounts('waiting')]);
      return { service: 'webhook-service', status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Webhook service is not ready');
    }
  }
}
