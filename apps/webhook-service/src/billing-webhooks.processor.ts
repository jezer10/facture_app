import type { WebhookEventEnvelope } from '@app/contracts';
import { WEBHOOK_DELIVERY_JOB, WEBHOOKS_QUEUE } from '@app/contracts';
import {
  PermanentWebhookDeliveryError,
  TransientWebhookDeliveryError,
  WebhookDeliveryService,
} from '@app/webhooks';
import { QueueProcessor, TaskWorker } from '@app/platform';
import type { TaskJob } from '@app/platform';
import { NonRetryableJobError } from '@app/platform';

@QueueProcessor(WEBHOOKS_QUEUE, { concurrency: 5 })
export class BillingWebhooksProcessor extends TaskWorker {
  constructor(private readonly deliveryService: WebhookDeliveryService) {
    super();
  }

  async process(job: TaskJob<WebhookEventEnvelope>): Promise<void> {
    if (job.name !== WEBHOOK_DELIVERY_JOB) {
      throw new NonRetryableJobError('Unsupported webhook job name');
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
        throw new NonRetryableJobError(`${error.code}: ${error.message}`);
      }

      throw new NonRetryableJobError('Webhook job failed without a retry classification');
    }
  }
}
