import { randomUUID } from 'node:crypto';

import type { WebhookEventType } from '@app/contracts';
import { parseEnvironment } from '@app/platform';
import type { EntityManager } from 'typeorm';

import { OutboxEventEntity } from '../database/entities';

export interface EnqueueWebhookEventInput {
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly eventType: WebhookEventType;
  readonly issuerId: string;
  readonly organizationId: string;
  readonly publicStatus: string;
  readonly resourceType: 'fiscal-document' | 'received-document';
}

export async function enqueueWebhookEvent(
  manager: EntityManager,
  input: EnqueueWebhookEventInput,
): Promise<void> {
  await manager.save(
    manager.create(OutboxEventEntity, {
      aggregateId: input.aggregateId,
      aggregateType: input.resourceType,
      attempts: 0,
      availableAt: new Date(),
      correlationId: input.correlationId,
      eventId: randomUUID(),
      eventType: `webhook.${input.eventType}`,
      issuerId: input.issuerId,
      lastErrorCode: null,
      lockedUntil: null,
      organizationId: input.organizationId,
      payload: {
        dataUrl: resourceDataUrl(input.resourceType, input.aggregateId),
        publicStatus: input.publicStatus,
        resourceType: input.resourceType,
      },
      status: 'pending',
    }),
  );
}

function resourceDataUrl(
  resourceType: EnqueueWebhookEventInput['resourceType'],
  resourceId: string,
): string {
  const publicUrl = withoutTrailingSlash(parseEnvironment(process.env).BILLING_PUBLIC_URL);
  const collection = resourceType === 'fiscal-document' ? 'fiscal-documents' : 'received-documents';
  return `${publicUrl}/api/v1/${collection}/${resourceId}`;
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
