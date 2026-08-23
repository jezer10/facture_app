import type { WebhookEventEnvelope } from '@app/contracts';
import { WEBHOOK_DELIVERY_JOB } from '@app/contracts';
import {
  PermanentWebhookDeliveryError,
  TransientWebhookDeliveryError,
  type WebhookDeliveryService,
} from '@app/webhooks';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';

import { BillingWebhooksProcessor } from './billing-webhooks.processor';

describe('BillingWebhooksProcessor', () => {
  it('passes BullMQ attempt numbers to the delivery service', async () => {
    const deliver = jest.fn().mockResolvedValue({
      delivered: 1,
      permanentlyFailed: 0,
      skipped: 0,
    });
    const processor = createProcessor(deliver);

    await processor.process(createJob({ attemptsMade: 2 }));

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt_123' }), 3, 3);
  });

  it('lets only typed transient errors reach BullMQ retry handling', async () => {
    const transientError = new TransientWebhookDeliveryError(
      'REMOTE_SERVER_ERROR',
      'Temporary remote failure',
    );
    const processor = createProcessor(jest.fn().mockRejectedValue(transientError));

    await expect(processor.process(createJob())).rejects.toBe(transientError);
  });

  it('converts permanent and unclassified errors into unrecoverable jobs', async () => {
    const permanentProcessor = createProcessor(
      jest
        .fn()
        .mockRejectedValue(
          new PermanentWebhookDeliveryError('INVALID_EVENT', 'Invalid event contract'),
        ),
    );
    const unknownProcessor = createProcessor(
      jest.fn().mockRejectedValue(new Error('Programming error')),
    );

    await expect(permanentProcessor.process(createJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(unknownProcessor.process(createJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rejects unknown names without running a delivery', async () => {
    const deliver = jest.fn();
    const processor = createProcessor(deliver);

    await expect(processor.process(createJob({ name: 'unknown-job' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(deliver).not.toHaveBeenCalled();
  });
});

function createProcessor(deliver: jest.Mock): BillingWebhooksProcessor {
  return new BillingWebhooksProcessor({ deliver } as unknown as WebhookDeliveryService);
}

function createJob(
  overrides: { readonly attemptsMade?: number; readonly name?: string } = {},
): Job<WebhookEventEnvelope, void, string> {
  return {
    attemptsMade: overrides.attemptsMade ?? 0,
    data: createEnvelope(),
    name: overrides.name ?? WEBHOOK_DELIVERY_JOB,
    opts: { attempts: 3 },
  } as Job<WebhookEventEnvelope, void, string>;
}

function createEnvelope(): WebhookEventEnvelope {
  return {
    correlationId: '00000000-0000-4000-8000-000000000003',
    eventId: 'evt_123',
    issuerId: '00000000-0000-4000-8000-000000000002',
    occurredAt: '2026-08-22T12:00:00.000Z',
    organizationId: '00000000-0000-4000-8000-000000000001',
    payload: {
      dataUrl: 'https://files.example.test/document.json',
      publicStatus: 'accepted',
      resourceId: '00000000-0000-4000-8000-000000000004',
      resourceType: 'fiscal-document',
    },
    payloadRef: 'organizations/organization-1/documents/document-1.json',
    payloadSha256: 'a'.repeat(64),
    type: 'fiscal-document.accepted.v1',
    version: 1,
  };
}
