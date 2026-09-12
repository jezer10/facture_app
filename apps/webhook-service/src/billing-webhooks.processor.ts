import type { WebhookEventEnvelope } from '@app/contracts';
import { WEBHOOK_DELIVERY_JOB, WEBHOOKS_QUEUE } from '@app/contracts';
import {
  PermanentWebhookDeliveryError,
  TransientWebhookDeliveryError,
  WebhookDeliveryService,
} from '@app/webhooks';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';

@Processor(WEBHOOKS_QUEUE, { concurrency: 5 })
export class BillingWebhooksProcessor extends WorkerHost {
  constructor(private readonly deliveryService: WebhookDeliveryService) {
    super();
  }

  async process(job: Job<WebhookEventEnvelope, void, string>): Promise<void> {
    if (job.name !== WEBHOOK_DELIVERY_JOB) {
      throw new UnrecoverableError('Unsupported webhook job name');
    }

    try {
      await this.deliveryService.deliver(
        job.data,
        job.attemptsMade + 1,
        Math.max(1, job.opts.attempts ?? 1),
      );
    } catch (error) {
      if (error instanceof TransientWebhookDeliveryError) {
        throw error;
      }

      if (error instanceof PermanentWebhookDeliveryError) {
        throw new UnrecoverableError(`${error.code}: ${error.message}`);
      }

      throw new UnrecoverableError('Webhook job failed without a retry classification');
    }
  }
}
