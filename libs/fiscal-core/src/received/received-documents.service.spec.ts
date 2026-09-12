import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import type { BillingPrincipal } from '../auth';
import {
  IssuerEntity,
  OutboxEventEntity,
  ReceivedDocumentEntity,
  ReceivedSyncEntity,
} from '../database/entities';
import { ReceivedDocumentsService } from './received-documents.service';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const ISSUER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ISSUER_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const CREATED_AT = new Date('2026-08-22T12:00:00.000Z');

const PRINCIPAL: BillingPrincipal = {
  kind: 'human',
  organizationId: ORGANIZATION_ID,
  platformAdmin: false,
  role: 'admin',
  subject: 'administrator',
};

describe('ReceivedDocumentsService idempotency', () => {
  it('rejects a missing Idempotency-Key before opening a transaction', async () => {
    const harness = createHarness();

    await expect(
      harness.service.requestSync(
        PRINCIPAL,
        requestCommand({ idempotencyKey: '' }),
        CORRELATION_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('loads an imported document only inside the principal organization', async () => {
    const harness = createHarness();
    const document = Object.assign(new ReceivedDocumentEntity(), {
      id: '55555555-5555-4555-8555-555555555555',
      organizationId: ORGANIZATION_ID,
      recipientIssuerId: ISSUER_ID,
    });
    harness.received.findOneBy.mockResolvedValue(document);

    await expect(harness.service.getReceivedDocument(PRINCIPAL, document.id)).resolves.toBe(
      document,
    );
    expect(harness.received.findOneBy).toHaveBeenCalledWith({
      id: document.id,
      organizationId: ORGANIZATION_ID,
    });
  });

  it('persists one sync and one outbox command atomically', async () => {
    const harness = createHarness();

    const result = await harness.service.requestSync(
      PRINCIPAL,
      requestCommand({ documentTypes: ['08', '01'], idempotencyKey: ' sync-import-42 ' }),
      CORRELATION_ID,
    );

    expect(harness.transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function));
    expect(harness.sync.findOne).toHaveBeenCalledWith({
      where: {
        idempotencyKey: 'sync-import-42',
        issuerId: ISSUER_ID,
        organizationId: ORGANIZATION_ID,
      },
    });
    const persisted = savedEntity(harness.sync);
    expect(persisted).toMatchObject({
      idempotencyKey: 'sync-import-42',
      issuerId: ISSUER_ID,
      organizationId: ORGANIZATION_ID,
      status: 'queued',
    });
    expect(persisted.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(savedEntity(harness.outbox)).toMatchObject({
      aggregateId: persisted.id,
      correlationId: CORRELATION_ID,
      eventType: 'sunat.received.sync.requested.v1',
      payload: { documentTypes: ['01', '08'] },
      status: 'pending',
    });
    expect(result).not.toHaveProperty('idempotencyKey');
    expect(result).not.toHaveProperty('requestSha256');
  });

  it('returns the original sync for an equivalent request in the same tenant and issuer', async () => {
    const harness = createHarness();
    const first = await harness.service.requestSync(
      PRINCIPAL,
      requestCommand({ documentTypes: ['01', '08'], idempotencyKey: 'same-key' }),
      CORRELATION_ID,
    );
    const existing = savedEntity(harness.sync);
    harness.sync.findOne.mockResolvedValue(existing);

    const replay = await harness.service.requestSync(
      PRINCIPAL,
      requestCommand({ documentTypes: ['08', '01'], idempotencyKey: 'same-key' }),
      CORRELATION_ID,
    );

    expect(replay).toEqual(first);
    expect(harness.sync.save).toHaveBeenCalledTimes(1);
    expect(harness.outbox.save).toHaveBeenCalledTimes(1);
  });

  it('returns a safe conflict when a key is reused with another payload', async () => {
    const harness = createHarness();
    const idempotencyKey = 'customer-secret-reference';
    await harness.service.requestSync(
      PRINCIPAL,
      requestCommand({ idempotencyKey }),
      CORRELATION_ID,
    );
    harness.sync.findOne.mockResolvedValue(savedEntity(harness.sync));

    let conflict: unknown;
    try {
      await harness.service.requestSync(
        PRINCIPAL,
        requestCommand({ endDate: '2026-08-11', idempotencyKey }),
        CORRELATION_ID,
      );
    } catch (error) {
      conflict = error;
    }

    expect(conflict).toBeInstanceOf(ConflictException);
    const response = (conflict as ConflictException).getResponse();
    expect(response).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(JSON.stringify(response)).not.toContain(idempotencyKey);
    expect(JSON.stringify(response)).not.toContain('2026-08-11');
    expect(harness.outbox.save).toHaveBeenCalledTimes(1);
  });

  it('allows the same key for a different issuer in the tenant', async () => {
    const harness = createHarness();

    await harness.service.requestSync(
      PRINCIPAL,
      requestCommand({ idempotencyKey: 'daily-sync' }),
      CORRELATION_ID,
    );
    await harness.service.requestSync(
      PRINCIPAL,
      requestCommand({ idempotencyKey: 'daily-sync', issuerId: OTHER_ISSUER_ID }),
      CORRELATION_ID,
    );

    expect(harness.sync.save).toHaveBeenCalledTimes(2);
    expect(harness.sync.findOne).toHaveBeenNthCalledWith(2, {
      where: {
        idempotencyKey: 'daily-sync',
        issuerId: OTHER_ISSUER_ID,
        organizationId: ORGANIZATION_ID,
      },
    });
  });

  it('resolves a concurrent unique-key race to the committed sync', async () => {
    const harness = createHarness();
    const command = requestCommand({ idempotencyKey: 'racing-key' });
    const first = await harness.service.requestSync(PRINCIPAL, command, CORRELATION_ID);
    const existing = savedEntity(harness.sync);
    harness.transaction.mockRejectedValueOnce({ code: '23505' });
    harness.sync.findOne.mockResolvedValue(existing);

    await expect(harness.service.requestSync(PRINCIPAL, command, CORRELATION_ID)).resolves.toEqual(
      first,
    );
  });
});

interface RepositoryDouble<T extends object> {
  readonly create: jest.Mock<T, [Partial<T>]>;
  readonly findOne: jest.Mock<Promise<T | null>, [unknown]>;
  readonly findOneBy: jest.Mock<Promise<T | null>, [unknown]>;
  readonly save: jest.Mock<Promise<T>, [T]>;
}

interface Harness {
  readonly outbox: RepositoryDouble<OutboxEventEntity>;
  readonly received: RepositoryDouble<ReceivedDocumentEntity>;
  readonly service: ReceivedDocumentsService;
  readonly sync: RepositoryDouble<ReceivedSyncEntity>;
  readonly transaction: jest.Mock;
}

function createHarness(): Harness {
  const sync = repositoryDouble(ReceivedSyncEntity);
  const outbox = repositoryDouble(OutboxEventEntity);
  const received = repositoryDouble(ReceivedDocumentEntity);
  sync.save.mockImplementation((value) => {
    value.createdAt ??= CREATED_AT;
    value.updatedAt ??= CREATED_AT;
    return Promise.resolve(value);
  });

  const manager = {
    existsBy: jest.fn().mockResolvedValue(true),
    findOneBy: jest.fn((_target: unknown, where: { id: string; organizationId: string }) =>
      Promise.resolve(
        Object.assign(new IssuerEntity(), {
          active: true,
          id: where.id,
          organizationId: where.organizationId,
        }),
      ),
    ),
    getRepository: jest.fn((target: object) => {
      if (target === ReceivedSyncEntity) return sync;
      if (target === OutboxEventEntity) return outbox;
      throw new Error('Missing repository double');
    }),
  } as unknown as EntityManager;
  const transaction = jest.fn(
    async <T>(
      _isolation: 'SERIALIZABLE',
      operation: (transactionManager: EntityManager) => Promise<T>,
    ): Promise<T> => operation(manager),
  );
  const dataSource = {
    getRepository: (target: object) => {
      if (target === ReceivedSyncEntity) return sync;
      if (target === ReceivedDocumentEntity) return received;
      throw new Error('Missing data source repository double');
    },
    transaction,
  } as unknown as DataSource;

  return {
    outbox,
    received,
    service: new ReceivedDocumentsService(dataSource),
    sync,
    transaction,
  };
}

function repositoryDouble<T extends object>(constructor: new () => T): RepositoryDouble<T> {
  return {
    create: jest.fn((values: Partial<T>) => Object.assign(new constructor(), values)),
    findOne: jest.fn((options: unknown): Promise<T | null> => {
      void options;
      return Promise.resolve(null);
    }),
    findOneBy: jest.fn((options: unknown): Promise<T | null> => {
      void options;
      return Promise.resolve(null);
    }),
    save: jest.fn((value: T) => Promise.resolve(value)),
  };
}

function savedEntity<T extends object>(repository: RepositoryDouble<T>): T {
  const saved = repository.save.mock.calls.at(-1)?.[0];
  if (!saved) {
    throw new Error('Expected a saved entity');
  }
  return saved;
}

function requestCommand(
  overrides: Partial<{
    readonly documentTypes: readonly ('01' | '03' | '07' | '08')[];
    readonly endDate: string;
    readonly idempotencyKey: string;
    readonly issuerId: string;
    readonly startDate: string;
  }> = {},
): {
  readonly documentTypes: readonly ('01' | '03' | '07' | '08')[];
  readonly endDate: string;
  readonly idempotencyKey: string;
  readonly issuerId: string;
  readonly startDate: string;
} {
  return {
    documentTypes: ['01'],
    endDate: '2026-08-10',
    idempotencyKey: 'sync-request',
    issuerId: ISSUER_ID,
    startDate: '2026-08-01',
    ...overrides,
  };
}
