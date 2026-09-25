import { WEBHOOKS_QUEUE } from '@app/contracts';
import { WEBHOOK_REPOSITORY, type WebhookRepository } from '@app/webhooks';
import { InjectTaskQueue } from '@app/platform';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { TaskQueue } from '@app/platform';

@Controller('internal/health')
export class InternalHealthController {
  constructor(
    @Inject(WEBHOOK_REPOSITORY)
    private readonly repository: WebhookRepository,
    @InjectTaskQueue(WEBHOOKS_QUEUE)
    private readonly queue: TaskQueue,
  ) {}

  @Get('live')
  live(): Readonly<{ service: string; status: string }> {
    return { service: 'webhook-service', status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<Readonly<{ service: string; status: string }>> {
    try {
      await Promise.all([this.repository.checkHealth(), this.queue.healthCheck()]);
      return { service: 'webhook-service', status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Webhook service is not ready');
    }
  }
}
