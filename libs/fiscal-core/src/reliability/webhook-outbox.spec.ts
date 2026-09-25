import type { EntityManager } from 'typeorm';

import { OutboxEventEntity } from '../database/entities';
import { enqueueWebhookEvent } from './webhook-outbox';

describe('enqueueWebhookEvent', () => {
  const originalPublicUrl = process.env.BILLING_PUBLIC_URL;

  beforeEach(() => {
    process.env.BILLING_PUBLIC_URL = 'https://billing.example/';
  });

  afterAll(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.BILLING_PUBLIC_URL;
    } else {
      process.env.BILLING_PUBLIC_URL = originalPublicUrl;
    }
  });

  it('persists a received-document event in the caller transaction', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const create = jest.fn((_target: unknown, values: Record<string, unknown>) => values);
    const manager = {
      create,
      save,
    } as unknown as EntityManager;

    await enqueueWebhookEvent(manager, {
      aggregateId: '11111111-1111-4111-8111-111111111111',
      correlationId: '22222222-2222-4222-8222-222222222222',
      eventType: 'received-document.imported.v1',
      issuerId: '33333333-3333-4333-8333-333333333333',
      organizationId: '44444444-4444-4444-8444-444444444444',
      publicStatus: 'imported',
      resourceType: 'received-document',
    });

    expect(create).toHaveBeenCalledWith(
      OutboxEventEntity,
      expect.objectContaining({
        aggregateType: 'received-document',
        eventType: 'webhook.received-document.imported.v1',
        payload: {
          dataUrl:
            'https://billing.example/api/v1/received-documents/11111111-1111-4111-8111-111111111111',
          publicStatus: 'imported',
          resourceType: 'received-document',
        },
        status: 'pending',
      }),
    );
    expect(save).toHaveBeenCalledTimes(1);
  });
});
