import { createWebhookDeliveryJobOptions } from './webhook-job-policy';

describe('createWebhookDeliveryJobOptions', () => {
  it('uses the stable event id as BullMQ job id and enables bounded retries', () => {
    expect(createWebhookDeliveryJobOptions('evt_123')).toMatchObject({
      attempts: 8,
      backoff: { delay: 1_000, type: 'exponential' },
      jobId: 'evt_123',
    });
  });
});
