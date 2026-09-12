import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { DataSource, EntityManager } from 'typeorm';
import type { PdfRenderEnvelope, SunatCommandEnvelope, WebhookEventEnvelope } from '@app/contracts';
import type { ObjectStoragePort } from '@app/platform';
import { canonicalJson, sha256 } from '@app/platform';

import { FiscalDocumentEntity, OutboxEventEntity } from '../database/entities';
import { OutboxPublisherService } from './outbox-publisher.service';

describe('OutboxPublisherService durable redrive', () => {
  const now = new Date('2026-08-22T12:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('keeps an exhausted event claimable in retrying state after publish failure', async () => {
    const event = outboxEvent({ attempts: 9, status: 'pending' });
    const harness = publisherHarness(event, new Error('queue unavailable'));
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await harness.publisher.publishReadyEvents();

    expect(harness.claimBuilder.where).toHaveBeenCalledWith(expect.stringContaining("'retrying'"));
    expect(harness.outboxRepository.update).toHaveBeenCalledWith(event.id, {
      status: 'retrying',
      lockedUntil: null,
      availableAt: new Date('2026-08-22T12:01:00.000Z'),
      lastErrorCode: 'OUTBOX_PUBLISH_FAILED',
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 10,
        eventId: event.eventId,
        retryStatus: 'retrying',
        nextAttemptAt: '2026-08-22T12:01:00.000Z',
      }),
    );
  });

  it('publishes a retrying event and marks it sent after the dependency recovers', async () => {
    const event = outboxEvent({ attempts: 10, status: 'retrying' });
    const harness = publisherHarness(event);

    await harness.publisher.publishReadyEvents();

    expect(harness.webhookQueue.add).toHaveBeenCalledTimes(1);
    expect(harness.manager.update).toHaveBeenCalledWith(OutboxEventEntity, event.id, {
      status: 'sent',
      lockedUntil: null,
      lastErrorCode: null,
    });
    expect(harness.outboxRepository.update).not.toHaveBeenCalled();
  });

  it('persists a processing webhook in the same transition that marks an issue command sent', async () => {
    const snapshot = { currency: 'PEN', documentType: '01', total: '118.00' };
    const document = Object.assign(new FiscalDocumentEntity(), {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      issuerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
      documentType: '01' as const,
      series: 'F001',
      number: '42',
      fiscalSnapshot: snapshot,
      snapshotSha256: sha256(canonicalJson(snapshot)),
      status: 'queued' as const,
    });
    const event = outboxEvent({
      aggregateId: document.id,
      attempts: 0,
      eventType: 'sunat.document.issue.requested.v1',
      issuerId: document.issuerId,
      organizationId: document.organizationId,
      status: 'pending',
    });
    const harness = publisherHarness(event, undefined, document);

    await harness.publisher.publishReadyEvents();

    expect(document.status).toBe('processing');
    const processingEvent = harness.created.find(
      (entry) =>
        entry.target === OutboxEventEntity &&
        entry.values.eventType === 'webhook.fiscal-document.processing.v1',
    );
    expect(processingEvent?.values).toMatchObject({
      aggregateId: document.id,
      eventType: 'webhook.fiscal-document.processing.v1',
    });
    const payload = processingEvent?.values.payload;
    if (!isRecord(payload)) {
      throw new Error('Expected a processing webhook payload');
    }
    expect(payload.dataUrl).toContain(`/api/v1/fiscal-documents/${document.id}`);
    expect(payload).toMatchObject({
      publicStatus: 'processing',
      resourceType: 'fiscal-document',
    });
  });
});

interface PublisherHarness {
  readonly publisher: OutboxPublisherService;
  readonly created: Array<{ readonly target: unknown; readonly values: Record<string, unknown> }>;
  readonly manager: {
    readonly update: jest.Mock;
  };
  readonly claimBuilder: {
    readonly where: jest.Mock;
  };
  readonly outboxRepository: {
    readonly update: jest.Mock;
  };
  readonly webhookQueue: {
    readonly add: jest.Mock;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publisherHarness(
  event: OutboxEventEntity,
  publishError?: Error,
  document?: FiscalDocumentEntity,
): PublisherHarness {
  const claimBuilder = fluentQueryBuilder({ getMany: () => Promise.resolve([event]) });
  const created: Array<{ target: unknown; values: Record<string, unknown> }> = [];
  const manager = {
    createQueryBuilder: jest.fn().mockReturnValue(claimBuilder),
    save: jest.fn(<T>(value: T): Promise<T> => Promise.resolve(value)),
    update: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn().mockResolvedValue(document ?? null),
    create: jest.fn((target: unknown, values: Record<string, unknown>) => {
      created.push({ target, values });
      return values;
    }),
  };
  const outboxRepository = {
    update: jest.fn().mockResolvedValue(undefined),
  };
  const documentRepository = {
    findOneByOrFail: jest.fn().mockResolvedValue(document),
  };
  const artifactBuilder = artifactInsertQueryBuilder();
  const dataSource = {
    transaction: jest.fn(
      <T>(work: (entityManager: EntityManager) => Promise<T>): Promise<T> =>
        work(manager as unknown as EntityManager),
    ),
    getRepository: jest.fn((target: object) =>
      target === FiscalDocumentEntity ? documentRepository : outboxRepository,
    ),
    createQueryBuilder: jest.fn().mockReturnValue(artifactBuilder),
  } as unknown as DataSource;
  const webhookQueue = {
    add: publishError
      ? jest.fn().mockRejectedValue(publishError)
      : jest.fn().mockResolvedValue(undefined),
  };
  const publisher = new OutboxPublisherService(
    dataSource,
    { add: jest.fn() } as unknown as Queue<SunatCommandEnvelope>,
    webhookQueue as unknown as Queue<WebhookEventEnvelope>,
    { add: jest.fn() } as unknown as Queue<PdfRenderEnvelope>,
    objectStorage(),
  );
  return { publisher, created, manager, claimBuilder, outboxRepository, webhookQueue };
}

function artifactInsertQueryBuilder(): {
  readonly insert: jest.Mock;
  readonly into: jest.Mock;
  readonly values: jest.Mock;
  readonly orIgnore: jest.Mock;
  readonly execute: jest.Mock;
} {
  const builder = {
    insert: jest.fn(),
    into: jest.fn(),
    values: jest.fn(),
    orIgnore: jest.fn(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  for (const method of [builder.insert, builder.into, builder.values, builder.orIgnore]) {
    method.mockReturnValue(builder);
  }
  return builder;
}

function fluentQueryBuilder(overrides: { readonly getMany: () => Promise<OutboxEventEntity[]> }): {
  readonly setLock: jest.Mock;
  readonly setOnLocked: jest.Mock;
  readonly where: jest.Mock;
  readonly andWhere: jest.Mock;
  readonly orderBy: jest.Mock;
  readonly take: jest.Mock;
  readonly getMany: jest.Mock;
} {
  const builder = {
    setLock: jest.fn(),
    setOnLocked: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    take: jest.fn(),
    getMany: jest.fn(overrides.getMany),
  };
  for (const method of [
    builder.setLock,
    builder.setOnLocked,
    builder.where,
    builder.andWhere,
    builder.orderBy,
    builder.take,
  ]) {
    method.mockReturnValue(builder);
  }
  return builder;
}

function outboxEvent(overrides: {
  readonly aggregateId?: string;
  readonly attempts: number;
  readonly eventType?: string;
  readonly issuerId?: string;
  readonly organizationId?: string;
  readonly status: OutboxEventEntity['status'];
}): OutboxEventEntity {
  return Object.assign(new OutboxEventEntity(), {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    aggregateType: 'fiscal-document',
    aggregateId: overrides.aggregateId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    eventType: overrides.eventType ?? 'webhook.fiscal-document.accepted.v1',
    organizationId: overrides.organizationId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    issuerId: overrides.issuerId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
    correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
    payload: {
      resourceType: 'fiscal-document',
      publicStatus: 'accepted',
      dataUrl: 'https://billing.test/api/v1/fiscal-documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    },
    attempts: overrides.attempts,
    status: overrides.status,
    availableAt: nowDate(),
    lockedUntil: null,
    lastErrorCode: null,
    createdAt: new Date('2026-08-22T11:55:00.000Z'),
    updatedAt: new Date('2026-08-22T11:55:00.000Z'),
  });
}

function nowDate(): Date {
  return new Date('2026-08-22T12:00:00.000Z');
}

function objectStorage(): ObjectStoragePort {
  return {
    healthCheck: jest.fn().mockResolvedValue(undefined),
    putImmutable: jest.fn((input) =>
      Promise.resolve({
        contentType: input.contentType,
        key: input.key,
        sha256: input.sha256,
        sizeBytes: input.body.length,
      }),
    ),
    get: jest.fn(),
    createReadUrl: jest.fn(),
  };
}
