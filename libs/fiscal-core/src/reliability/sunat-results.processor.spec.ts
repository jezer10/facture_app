import { sunatDocumentArtifactObjectKey } from '@app/contracts';
import type { ReceivedDocumentRecord, SunatResultEnvelope } from '@app/contracts';
import { canonicalJson, sha256, type ObjectStoragePort } from '@app/platform';
import type { Job } from 'bullmq';
import type { DataSource, EntityManager } from 'typeorm';

import {
  DocumentStateHistoryEntity,
  FiscalDocumentEntity,
  OutboxEventEntity,
  ReceivedSyncEntity,
} from '../database/entities';
import { SunatResultsProcessor } from './sunat-results.processor';

describe('SunatResultsProcessor', () => {
  it('emits a durable processing webhook when a result wins the publish-state race', async () => {
    const result = reconcilingResultFixture();
    const storedPayload = Buffer.from(canonicalJson(result.payload), 'utf8');
    const verifiedResult = { ...result, payloadSha256: sha256(storedPayload) };
    const document = Object.assign(new FiscalDocumentEntity(), {
      id: result.payload.documentId,
      organizationId: result.organizationId,
      issuerId: result.issuerId,
      status: 'queued' as const,
    });
    const created: Array<{ target: unknown; values: Record<string, unknown> }> = [];
    const manager = entityManager({ created, document });
    const processor = new SunatResultsProcessor(dataSource(manager), objectStorage(storedPayload));

    await processor.process({ data: verifiedResult } as Job<SunatResultEnvelope>);

    expect(document.status).toBe('processing');
    const processingEvent = created.find(
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

  it('restores the exact accepted state when SUNAT rejects a void request', async () => {
    const result = rejectedResultFixture();
    const storedPayload = Buffer.from(canonicalJson(result.payload), 'utf8');
    const verifiedResult = { ...result, payloadSha256: sha256(storedPayload) };
    const acceptedAt = new Date('2026-08-20T15:00:00.000Z');
    const document = Object.assign(new FiscalDocumentEntity(), {
      id: result.payload.documentId,
      organizationId: result.organizationId,
      issuerId: result.issuerId,
      status: 'void_pending' as const,
      acceptedAt,
    });
    const created: Array<{ target: unknown; values: Record<string, unknown> }> = [];
    const manager = entityManager({
      document,
      voidRequest: Object.assign(new DocumentStateHistoryEntity(), {
        documentId: document.id,
        fromStatus: 'accepted_with_observations' as const,
        toStatus: 'void_pending' as const,
        reason: 'void_requested',
      }),
      created,
    });
    const processor = new SunatResultsProcessor(dataSource(manager), objectStorage(storedPayload));

    await processor.process({ data: verifiedResult } as Job<SunatResultEnvelope>);

    expect(document.status).toBe('accepted_with_observations');
    expect(document.acceptedAt).toBe(acceptedAt);
    const restoredTransition = created.find((entry) => entry.target === DocumentStateHistoryEntity);
    expect(restoredTransition?.values).toEqual(
      expect.objectContaining({
        fromStatus: 'void_pending',
        toStatus: 'accepted_with_observations',
        reason: 'void-rejected:VOID-REJECTED',
      }),
    );
    expect(
      created.some(
        (entry) =>
          entry.target === OutboxEventEntity && entry.values.eventType === 'core.pdf.requested.v1',
      ),
    ).toBe(false);
  });

  it('marks a received-document sync failed exactly once with a safe summary', async () => {
    const result = receivedSyncFailedResultFixture();
    const storedPayload = Buffer.from(canonicalJson(result.payload), 'utf8');
    const verifiedResult = { ...result, payloadSha256: sha256(storedPayload) };
    const sync = Object.assign(new ReceivedSyncEntity(), {
      id: result.payload.syncId,
      organizationId: result.organizationId,
      issuerId: result.issuerId,
      status: 'processing' as const,
      resultSummary: {},
    });
    const saved: unknown[] = [];
    let firstClaim = true;
    const manager = entityManager({
      receivedSync: sync,
      created: [],
      saved,
      claimInbox: () => {
        const claimed = firstClaim;
        firstClaim = false;
        return claimed;
      },
    });
    const processor = new SunatResultsProcessor(dataSource(manager), objectStorage(storedPayload));

    await processor.process({ data: verifiedResult } as Job<SunatResultEnvelope>);
    await processor.process({ data: verifiedResult } as Job<SunatResultEnvelope>);

    expect(sync.status).toBe('failed');
    expect(sync.resultSummary).toEqual({
      errorCode: 'SUNAT_CREDENTIAL_UNAVAILABLE',
      errorDescription: 'No hay credenciales SUNAT utilizables para el emisor.',
    });
    expect(saved).toEqual([sync]);
  });

  it('rejects an artifact key from another issuer before changing document state', async () => {
    const result = acceptedResultWithForeignArtifactFixture();
    const storedPayload = Buffer.from(canonicalJson(result.payload), 'utf8');
    const verifiedResult = { ...result, payloadSha256: sha256(storedPayload) };
    const document = Object.assign(new FiscalDocumentEntity(), {
      id: result.payload.documentId,
      organizationId: result.organizationId,
      issuerId: result.issuerId,
      status: 'queued' as const,
      acceptedAt: null,
    });
    const saved: unknown[] = [];
    const manager = entityManager({ document, created: [], saved });
    const processor = new SunatResultsProcessor(dataSource(manager), objectStorage(storedPayload));

    await expect(
      processor.process({ data: verifiedResult } as Job<SunatResultEnvelope>),
    ).rejects.toThrow('Artifact object key does not belong to the fiscal document');

    expect(document.status).toBe('queued');
    expect(document.acceptedAt).toBeNull();
    expect(saved).toEqual([]);
  });

  it('emits an imported webhook only when Core inserts a new received document', async () => {
    const records = [receivedRecordFixture(), receivedRecordFixture({ number: '102' })];
    const recordsBody = Buffer.from(canonicalJson(records), 'utf8');
    const result = receivedSyncCompletedResultFixture(sha256(recordsBody));
    const resultBody = Buffer.from(canonicalJson(result.payload), 'utf8');
    const verifiedResult = { ...result, payloadSha256: sha256(resultBody) };
    const sync = Object.assign(new ReceivedSyncEntity(), {
      id: result.payload.syncId,
      organizationId: result.organizationId,
      issuerId: result.issuerId,
      status: 'processing' as const,
      resultSummary: {},
    });
    const created: Array<{ target: unknown; values: Record<string, unknown> }> = [];
    const insertReceivedDocument = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1' }])
      .mockResolvedValueOnce([]);
    const manager = entityManager({
      created,
      query: insertReceivedDocument,
      receivedSync: sync,
    });
    const storage = objectStorageByReference({
      [result.payloadRef]: resultBody,
      [result.payload.recordsRef]: recordsBody,
    });
    const processor = new SunatResultsProcessor(dataSource(manager), storage);

    await processor.process({ data: verifiedResult } as Job<SunatResultEnvelope>);

    const importedEvents = created.filter(
      (entry) =>
        entry.target === OutboxEventEntity &&
        entry.values.eventType === 'webhook.received-document.imported.v1',
    );
    expect(importedEvents).toHaveLength(1);
    expect(importedEvents[0]?.values).toMatchObject({
      aggregateId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      correlationId: result.correlationId,
      payload: {
        dataUrl:
          'http://localhost:3000/api/v1/received-documents/cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
        publicStatus: 'imported',
        resourceType: 'received-document',
      },
    });
    expect(insertReceivedDocument).toHaveBeenCalledTimes(2);
    expect(sync.status).toBe('completed');
  });
});

interface EntityManagerFixture {
  readonly document?: FiscalDocumentEntity;
  readonly voidRequest?: DocumentStateHistoryEntity;
  readonly receivedSync?: ReceivedSyncEntity;
  readonly created: Array<{ target: unknown; values: Record<string, unknown> }>;
  readonly saved?: unknown[];
  readonly claimInbox?: () => boolean;
  readonly query?: jest.Mock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entityManager(fixture: EntityManagerFixture): EntityManager {
  const claimQuery = insertQueryBuilder(fixture.claimInbox);
  return {
    createQueryBuilder: () => claimQuery,
    findOne: (target: unknown) =>
      Promise.resolve(
        target === FiscalDocumentEntity
          ? (fixture.document ?? null)
          : target === DocumentStateHistoryEntity
            ? (fixture.voidRequest ?? null)
            : target === ReceivedSyncEntity
              ? (fixture.receivedSync ?? null)
              : null,
      ),
    create: (target: unknown, values: Record<string, unknown>) => {
      fixture.created.push({ target, values });
      return values;
    },
    save: <T>(entity: T): Promise<T> => {
      fixture.saved?.push(entity);
      return Promise.resolve(entity);
    },
    query: fixture.query ?? jest.fn().mockResolvedValue([]),
  } as unknown as EntityManager;
}

function objectStorageByReference(bodies: Readonly<Record<string, Buffer>>): ObjectStoragePort {
  return {
    healthCheck: jest.fn().mockResolvedValue(undefined),
    putImmutable: jest.fn(),
    get: jest.fn((key: string) => {
      const body = bodies[key];
      if (!body) {
        throw new Error(`Unexpected object reference: ${key}`);
      }
      return Promise.resolve(body);
    }),
    createReadUrl: jest.fn(),
  };
}

function dataSource(manager: EntityManager): DataSource {
  return {
    transaction: <T>(work: (transactionManager: EntityManager) => Promise<T>): Promise<T> =>
      work(manager),
  } as unknown as DataSource;
}

function insertQueryBuilder(claimInbox: () => boolean = () => true): {
  insert(): unknown;
  into(): unknown;
  values(): unknown;
  orIgnore(): unknown;
  returning(): unknown;
  execute(): Promise<{ identifiers: Array<{ id: string }> }>;
} {
  const builder = {
    insert: () => builder,
    into: () => builder,
    values: () => builder,
    orIgnore: () => builder,
    returning: () => builder,
    execute: () => Promise.resolve({ identifiers: claimInbox() ? [{ id: 'inbox-1' }] : [] }),
  };
  return builder;
}

function objectStorage(body: Buffer): ObjectStoragePort {
  return {
    healthCheck: jest.fn().mockResolvedValue(undefined),
    putImmutable: jest.fn(),
    get: jest.fn().mockResolvedValue(body),
    createReadUrl: jest.fn(),
  };
}

function rejectedResultFixture(): Extract<
  SunatResultEnvelope,
  { type: 'sunat.document.rejected.v1' }
> {
  return {
    eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    type: 'sunat.document.rejected.v1',
    version: 1,
    occurredAt: '2026-08-22T00:00:00.000Z',
    correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    issuerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    payloadRef: 'sunat/results/org/issuer/result.json',
    payloadSha256: '0'.repeat(64),
    payload: {
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
      submissionId: 'mock-void',
      code: 'VOID-REJECTED',
      description: 'La comunicación de baja fue rechazada.',
      artifacts: [],
    },
  };
}

function reconcilingResultFixture(): Extract<
  SunatResultEnvelope,
  { type: 'sunat.document.reconciling.v1' }
> {
  return {
    eventId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    type: 'sunat.document.reconciling.v1',
    version: 1,
    occurredAt: '2026-08-22T00:00:00.000Z',
    correlationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
    organizationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
    issuerId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
    payloadRef: 'sunat/results/org/issuer/reconciling.json',
    payloadSha256: '0'.repeat(64),
    payload: {
      documentId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd5',
      submissionId: 'submission-1',
      ticket: 'ticket-1',
      nextCheckAt: '2026-08-22T00:01:00.000Z',
    },
  };
}

function receivedSyncFailedResultFixture(): Extract<
  SunatResultEnvelope,
  { type: 'sunat.received.sync.failed.v1' }
> {
  return {
    eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    type: 'sunat.received.sync.failed.v1',
    version: 1,
    occurredAt: '2026-08-22T00:00:00.000Z',
    correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
    issuerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
    payloadRef: 'sunat/results/org/issuer/sync-failed.json',
    payloadSha256: '0'.repeat(64),
    payload: {
      syncId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
      code: 'SUNAT_CREDENTIAL_UNAVAILABLE',
      description: 'No hay credenciales SUNAT utilizables para el emisor.',
      retryable: false,
    },
  };
}

function receivedSyncCompletedResultFixture(
  recordsSha256: string,
): Extract<SunatResultEnvelope, { type: 'sunat.received.sync.completed.v1' }> {
  return {
    eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
    type: 'sunat.received.sync.completed.v1',
    version: 1,
    occurredAt: '2026-08-22T00:00:00.000Z',
    correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
    organizationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
    issuerId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
    payloadRef: 'sunat/results/org/issuer/sync-completed.json',
    payloadSha256: '0'.repeat(64),
    payload: {
      syncId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
      failedCount: 0,
      importedCount: 2,
      skippedCount: 0,
      recordsRef: 'sunat/results/org/issuer/received-records.json',
      recordsSha256,
    },
  };
}

function acceptedResultWithForeignArtifactFixture(): Extract<
  SunatResultEnvelope,
  { type: 'sunat.document.accepted.v1' }
> {
  const organizationId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
  const issuerId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';
  const documentId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5';
  const digest = 'd'.repeat(64);
  return {
    eventId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    type: 'sunat.document.accepted.v1',
    version: 1,
    occurredAt: '2026-08-22T00:00:00.000Z',
    correlationId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
    organizationId,
    issuerId,
    payloadRef: 'sunat/results/org/issuer/accepted.json',
    payloadSha256: '0'.repeat(64),
    payload: {
      documentId,
      submissionId: 'mock-accepted',
      acceptedAt: '2026-08-22T00:00:00.000Z',
      observationCodes: [],
      artifacts: [
        {
          kind: 'xml',
          objectKey: sunatDocumentArtifactObjectKey({
            organizationId,
            issuerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            documentId,
            kind: 'xml',
            sha256: digest,
          }),
          sha256: digest,
          contentType: 'application/xml',
          sizeBytes: 128,
        },
      ],
    },
  };
}

function receivedRecordFixture(
  overrides: Partial<ReceivedDocumentRecord> = {},
): ReceivedDocumentRecord {
  const snapshot = {
    currency: 'PEN',
    supplier: { legalName: 'Proveedor SAC', ruc: '20123456789' },
    total: '118.00',
  };
  return {
    supplierRuc: '20123456789',
    documentType: '01',
    series: 'F001',
    number: '101',
    source: 'sunat',
    issueDate: '2026-08-20',
    snapshot,
    snapshotSha256: sha256(canonicalJson(snapshot)),
    ...overrides,
  };
}
