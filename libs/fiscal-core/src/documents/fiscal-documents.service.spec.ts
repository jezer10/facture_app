import 'reflect-metadata';

import type { CreateFiscalDocumentInput } from '@app/contracts';
import { createImmutableSnapshot } from '@app/fiscal-domain';
import { ValidationPipe } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import {
  CreateFiscalDocumentDto,
  FiscalAddressDto,
  FiscalDocumentLineDto,
  FiscalPartyDto,
} from '../../../../apps/billing-api/src/documents/fiscal-document.dto';

import {
  DocumentStateHistoryEntity,
  FiscalDocumentEntity,
  FiscalDocumentLineEntity,
  IdempotencyRequestEntity,
  IssuerEntity,
  IssuerSeriesEntity,
  OutboxEventEntity,
  ServiceAccountIssuerGrantEntity,
} from '../database/entities';
import {
  FiscalDocumentNotFoundError,
  IdempotencyConflictError,
  InvalidFiscalDocumentStateError,
  InvalidReferenceDocumentError,
  IssuerAccessDeniedError,
} from './fiscal-documents.errors';
import { FiscalDocumentsService } from './fiscal-documents.service';
import type { FiscalDocumentsPrincipal } from './fiscal-documents.types';

type EntityConstructor<T extends object> = new () => T;

interface RepositoryDouble<T extends object> {
  readonly create: jest.Mock<T, [Partial<T>]>;
  readonly find: jest.Mock<Promise<T[]>, [unknown?]>;
  readonly findOne: jest.Mock<Promise<T | null>, [unknown?]>;
  readonly save: jest.Mock<Promise<T | T[]>, [T | T[]]>;
}

interface TestHarness {
  readonly dataSource: DataSource;
  readonly document: RepositoryDouble<FiscalDocumentEntity>;
  readonly grant: RepositoryDouble<ServiceAccountIssuerGrantEntity>;
  readonly history: RepositoryDouble<DocumentStateHistoryEntity>;
  readonly idempotency: RepositoryDouble<IdempotencyRequestEntity>;
  readonly issuer: RepositoryDouble<IssuerEntity>;
  readonly line: RepositoryDouble<FiscalDocumentLineEntity>;
  readonly manager: EntityManager;
  readonly outbox: RepositoryDouble<OutboxEventEntity>;
  readonly series: RepositoryDouble<IssuerSeriesEntity>;
  readonly service: FiscalDocumentsService;
  readonly transaction: jest.Mock;
}

const PRINCIPAL: FiscalDocumentsPrincipal = {
  correlationId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  serviceAccountId: '33333333-3333-4333-8333-333333333333',
};
const HUMAN_PRINCIPAL: FiscalDocumentsPrincipal = {
  correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  organizationId: PRINCIPAL.organizationId,
  subject: 'auth0|admin-1',
};
const ISSUER_ID = '44444444-4444-4444-8444-444444444444';
const SERIES_ID = '55555555-5555-4555-8555-555555555555';

describe('FiscalDocumentsService.create', () => {
  it('normalizes transformed transport DTOs before creating immutable snapshots', async () => {
    const harness = createHarness();
    const validationPipe = new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    });
    const transformed: unknown = await validationPipe.transform(
      invoiceInput({
        customer: {
          address: {
            countryCode: 'PE',
            district: 'Lima',
            line: 'Av. Prueba 123',
          },
          identityNumber: '20600000001',
          identityType: '6',
          legalName: 'CLIENTE SAC',
        },
      }),
      {
        data: undefined,
        metatype: CreateFiscalDocumentDto,
        type: 'body',
      },
    );

    expect(transformed).toBeInstanceOf(CreateFiscalDocumentDto);
    if (!(transformed instanceof CreateFiscalDocumentDto)) {
      throw new Error('ValidationPipe did not create the expected transport DTO');
    }
    const input = transformed;
    expect(input.customer).toBeInstanceOf(FiscalPartyDto);
    expect(input.customer.address).toBeInstanceOf(FiscalAddressDto);
    expect(input.lines[0]).toBeInstanceOf(FiscalDocumentLineDto);

    const result = await harness.service.create(PRINCIPAL, {
      idempotencyKey: 'transport-dto',
      input,
    });

    expect(result).toMatchObject({ number: '41', status: 'queued' });
    expect(savedEntity(harness.document).customerSnapshot).toEqual({
      address: {
        countryCode: 'PE',
        district: 'Lima',
        line: 'Av. Prueba 123',
      },
      identityNumber: '20600000001',
      identityType: '6',
      legalName: 'CLIENTE SAC',
    });
  });

  it('persists document, lines, initial state, outbox and idempotency atomically', async () => {
    const harness = createHarness();

    const result = await harness.service.create(PRINCIPAL, {
      idempotencyKey: ' invoice-42 ',
      input: invoiceInput(),
    });

    expect(harness.transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function));
    expect(harness.series.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(savedEntity(harness.series).nextNumber).toBe('42');
    expect(result).toMatchObject({
      documentType: '01',
      issuerId: ISSUER_ID,
      number: '41',
      series: 'F001',
      status: 'queued',
    });

    const document = savedEntity(harness.document);
    expect(document.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(document.totals).toMatchObject({
      igvAmount: '34.20',
      payableAmount: '224.20',
      taxableAmount: '190.00',
    });
    expect(harness.line.save).toHaveBeenCalledWith([
      expect.objectContaining({ documentId: document.id, lineNumber: 1 }),
    ]);
    expect(savedEntity(harness.history)).toMatchObject({
      documentId: document.id,
      fromStatus: null,
      reason: 'document_created',
      toStatus: 'queued',
    });
    expect(savedEntity(harness.outbox)).toMatchObject({
      aggregateId: document.id,
      eventType: 'sunat.document.issue.requested.v1',
      payload: {
        documentId: document.id,
        documentType: '01',
        number: '41',
        series: 'F001',
      },
      status: 'pending',
    });
    expect(savedEntity(harness.idempotency)).toMatchObject({
      key: 'invoice-42',
      organizationId: PRINCIPAL.organizationId,
      resourceId: document.id,
      resourceType: 'fiscal_document',
    });
  });

  it('returns the original resource for the same organization, key and request hash', async () => {
    const harness = createHarness();
    const command = { idempotencyKey: 'same-key', input: invoiceInput() };
    const first = await harness.service.create(PRINCIPAL, command);
    const idempotency = savedEntity(harness.idempotency);
    const document = savedEntity(harness.document);
    harness.idempotency.findOne.mockResolvedValue(idempotency);
    harness.document.findOne.mockResolvedValue(document);

    const second = await harness.service.create(PRINCIPAL, command);

    expect(second).toEqual(first);
    expect(harness.series.findOne).toHaveBeenCalledTimes(1);
    expect(harness.document.save).toHaveBeenCalledTimes(1);
    expect(harness.outbox.save).toHaveBeenCalledTimes(1);
  });

  it('allocates monotonically increasing correlatives for distinct requests', async () => {
    const harness = createHarness();

    const first = await harness.service.create(PRINCIPAL, {
      idempotencyKey: 'first-document',
      input: invoiceInput(),
    });
    const second = await harness.service.create(PRINCIPAL, {
      idempotencyKey: 'second-document',
      input: invoiceInput({ purchaseOrder: 'PO-2' }),
    });

    expect(first.number).toBe('41');
    expect(second.number).toBe('42');
    expect(savedEntity(harness.series).nextNumber).toBe('43');
  });

  it('throws a typed conflict when a key is reused for a different request', async () => {
    const harness = createHarness();
    harness.idempotency.findOne.mockResolvedValue(
      entity(IdempotencyRequestEntity, {
        key: 'same-key',
        organizationId: PRINCIPAL.organizationId,
        requestSha256: 'a'.repeat(64),
        resourceId: '66666666-6666-4666-8666-666666666666',
        resourceType: 'fiscal_document',
      }),
    );

    await expect(
      harness.service.create(PRINCIPAL, {
        idempotencyKey: 'same-key',
        input: invoiceInput(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(harness.series.findOne).not.toHaveBeenCalled();
  });

  it('resolves a concurrent idempotency unique violation to the committed resource', async () => {
    const harness = createHarness();
    const input = invoiceInput();
    const existingDocument = fiscalDocument({ id: '77777777-7777-4777-8777-777777777777' });
    harness.transaction.mockRejectedValueOnce({ code: '23505' });
    harness.idempotency.findOne.mockResolvedValue(
      entity(IdempotencyRequestEntity, {
        key: 'racing-key',
        organizationId: PRINCIPAL.organizationId,
        requestSha256: createImmutableSnapshot(input).sha256,
        resourceId: existingDocument.id,
        resourceType: 'fiscal_document',
      }),
    );
    harness.document.findOne.mockResolvedValue(existingDocument);

    const result = await harness.service.create(PRINCIPAL, {
      idempotencyKey: 'racing-key',
      input,
    });

    expect(result.id).toBe(existingDocument.id);
  });

  it('denies an issuer without a grant before allocating a number', async () => {
    const harness = createHarness();
    harness.grant.findOne.mockResolvedValue(null);

    await expect(
      harness.service.create(PRINCIPAL, {
        idempotencyKey: 'denied',
        input: invoiceInput(),
      }),
    ).rejects.toBeInstanceOf(IssuerAccessDeniedError);
    expect(harness.series.findOne).not.toHaveBeenCalled();
  });

  it('accepts notes only when the referenced document identity is accepted', async () => {
    const harness = createHarness();
    const reference = fiscalDocument({
      documentType: '01',
      id: '88888888-8888-4888-8888-888888888888',
      number: '8',
      series: 'F001',
      status: 'accepted',
    });
    harness.document.findOne.mockResolvedValue(reference);
    harness.series.findOne.mockResolvedValue(series({ documentType: '07', series: 'FC01' }));

    const result = await harness.service.create(PRINCIPAL, {
      idempotencyKey: 'credit-note',
      input: noteInput(reference),
    });

    expect(result.referenceDocumentId).toBe(reference.id);
    expect(harness.document.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_read' } }),
    );
  });

  it('rejects a note whose referenced document is not accepted', async () => {
    const harness = createHarness();
    const reference = fiscalDocument({
      id: '88888888-8888-4888-8888-888888888888',
      status: 'rejected',
    });
    harness.document.findOne.mockResolvedValue(reference);

    await expect(
      harness.service.create(PRINCIPAL, {
        idempotencyKey: 'bad-note',
        input: noteInput(reference),
      }),
    ).rejects.toBeInstanceOf(InvalidReferenceDocumentError);
    expect(harness.series.findOne).not.toHaveBeenCalled();
  });

  it('maps explicitly modeled free exonerated lines without making them payable', async () => {
    const harness = createHarness();
    const input = invoiceInput({
      lines: [
        {
          description: 'Bonificación',
          freeTaxTreatment: 'exonerated',
          quantity: '2',
          referenceUnitValue: '5',
          taxAffectation: 'free',
          taxRate: '0',
          unitCode: 'NIU',
          unitValue: '0',
        },
      ],
    });

    await harness.service.create(PRINCIPAL, { idempotencyKey: 'free-line', input });

    expect(savedEntity(harness.document).totals).toMatchObject({
      freeAmount: '10.00',
      freeIgvAmount: '0.00',
      payableAmount: '0.00',
    });
  });
});

describe('FiscalDocumentsService tenant-safe queries', () => {
  it('gets a document only when it belongs to the tenant and issuer grant', async () => {
    const harness = createHarness();
    const document = fiscalDocument();
    harness.document.findOne.mockResolvedValue(document);

    const result = await harness.service.get(PRINCIPAL, document.id);

    expect(result.id).toBe(document.id);
    expect(harness.document.findOne).toHaveBeenCalledWith({
      where: { id: document.id, organizationId: PRINCIPAL.organizationId },
    });
  });

  it('conceals a document when its issuer is not granted', async () => {
    const harness = createHarness();
    const document = fiscalDocument();
    harness.document.findOne.mockResolvedValue(document);
    harness.grant.findOne.mockResolvedValue(null);

    await expect(harness.service.get(PRINCIPAL, document.id)).rejects.toBeInstanceOf(
      FiscalDocumentNotFoundError,
    );
  });

  it('lists only issuer grants in the principal organization', async () => {
    const harness = createHarness();
    harness.grant.find.mockResolvedValue([
      entity(ServiceAccountIssuerGrantEntity, {
        issuerId: ISSUER_ID,
        organizationId: PRINCIPAL.organizationId,
        serviceAccountId: PRINCIPAL.serviceAccountId,
      }),
    ]);
    harness.document.find.mockResolvedValue([fiscalDocument()]);

    const result = await harness.service.list(PRINCIPAL, { limit: 25, offset: 0 });

    expect(result).toHaveLength(1);
    expect(harness.grant.find).toHaveBeenCalledWith({
      where: {
        organizationId: PRINCIPAL.organizationId,
        serviceAccountId: PRINCIPAL.serviceAccountId,
      },
    });
    const listOptions = harness.document.find.mock.calls[0]?.[0] as {
      readonly skip: number;
      readonly take: number;
      readonly where: { readonly organizationId: string };
    };
    expect(listOptions.skip).toBe(0);
    expect(listOptions.take).toBe(25);
    expect(listOptions.where).toMatchObject({ organizationId: PRINCIPAL.organizationId });
  });
});

describe('FiscalDocumentsService.requestVoid', () => {
  it('locks an accepted document and records its outbox transition atomically', async () => {
    const harness = createHarness();
    const document = fiscalDocument({ status: 'accepted' });
    harness.document.findOne.mockResolvedValue(document);

    const result = await harness.service.requestVoid(PRINCIPAL, {
      documentId: document.id,
      reason: ' Error en los datos ',
    });

    expect(harness.transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function));
    expect(harness.document.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(result.status).toBe('void_pending');
    expect(savedEntity(harness.history)).toMatchObject({
      documentId: document.id,
      fromStatus: 'accepted',
      toStatus: 'void_pending',
    });
    const outbox = savedEntity(harness.outbox);
    expect(outbox.eventType).toBe('sunat.document.void.requested.v1');
    expect(outbox.payload).toMatchObject({
      documentId: document.id,
      reason: 'Error en los datos',
    });
  });

  it('rejects void requests for non-accepted states without writing history', async () => {
    const harness = createHarness();
    harness.document.findOne.mockResolvedValue(fiscalDocument({ status: 'processing' }));

    await expect(
      harness.service.requestVoid(PRINCIPAL, {
        documentId: '99999999-9999-4999-8999-999999999999',
        reason: 'No corresponde',
      }),
    ).rejects.toBeInstanceOf(InvalidFiscalDocumentStateError);
    expect(harness.history.save).not.toHaveBeenCalled();
    expect(harness.outbox.save).not.toHaveBeenCalled();
  });
});

describe('FiscalDocumentsService human administrators', () => {
  it('uses organization-wide access for create, get, list and void with safe actor metadata', async () => {
    const harness = createHarness();
    harness.grant.findOne.mockResolvedValue(null);
    harness.grant.find.mockResolvedValue([]);

    const created = await harness.service.create(HUMAN_PRINCIPAL, {
      idempotencyKey: 'admin-created',
      input: invoiceInput(),
    });
    const document = savedEntity(harness.document);
    const creationHistory = savedEntityAt(harness.history, 0);
    expect(creationHistory.metadata).toEqual({
      actorId: HUMAN_PRINCIPAL.subject,
      actorType: 'human',
      correlationId: HUMAN_PRINCIPAL.correlationId,
    });
    expect(harness.issuer.findOne).toHaveBeenCalledWith({
      where: { id: ISSUER_ID, organizationId: HUMAN_PRINCIPAL.organizationId },
    });

    harness.document.findOne.mockResolvedValue(document);
    expect((await harness.service.get(HUMAN_PRINCIPAL, document.id)).id).toBe(created.id);

    harness.document.find.mockResolvedValue([document]);
    expect(await harness.service.list(HUMAN_PRINCIPAL)).toHaveLength(1);

    document.status = 'accepted';
    const voided = await harness.service.requestVoid(HUMAN_PRINCIPAL, {
      documentId: document.id,
      reason: 'Solicitud administrativa',
    });
    expect(voided.status).toBe('void_pending');
    expect(savedEntity(harness.history).metadata).toMatchObject({
      actorId: HUMAN_PRINCIPAL.subject,
      actorType: 'human',
    });
    expect(harness.grant.findOne).not.toHaveBeenCalled();
    expect(harness.grant.find).not.toHaveBeenCalled();
  });
});

function createHarness(): TestHarness {
  const document = repositoryDouble(FiscalDocumentEntity);
  const grant = repositoryDouble(ServiceAccountIssuerGrantEntity);
  const history = repositoryDouble(DocumentStateHistoryEntity);
  const idempotency = repositoryDouble(IdempotencyRequestEntity);
  const issuer = repositoryDouble(IssuerEntity);
  const line = repositoryDouble(FiscalDocumentLineEntity);
  const outbox = repositoryDouble(OutboxEventEntity);
  const seriesRepository = repositoryDouble(IssuerSeriesEntity);
  const repositories = new Map<object, unknown>([
    [DocumentStateHistoryEntity, history],
    [FiscalDocumentEntity, document],
    [FiscalDocumentLineEntity, line],
    [IdempotencyRequestEntity, idempotency],
    [IssuerEntity, issuer],
    [IssuerSeriesEntity, seriesRepository],
    [OutboxEventEntity, outbox],
    [ServiceAccountIssuerGrantEntity, grant],
  ]);
  const getRepository = jest.fn((target: object): unknown => {
    const repository = repositories.get(target);
    if (!repository) {
      throw new Error('Missing repository double');
    }
    return repository;
  });
  const manager = { getRepository } as unknown as EntityManager;
  const transaction = jest.fn(
    async <T>(
      _isolation: 'SERIALIZABLE',
      operation: (transactionManager: EntityManager) => Promise<T>,
    ): Promise<T> => operation(manager),
  );
  const dataSource = {
    getRepository,
    manager,
    transaction,
  } as unknown as DataSource;

  issuer.findOne.mockResolvedValue(activeIssuer());
  grant.findOne.mockResolvedValue(
    entity(ServiceAccountIssuerGrantEntity, {
      issuerId: ISSUER_ID,
      organizationId: PRINCIPAL.organizationId,
      serviceAccountId: PRINCIPAL.serviceAccountId,
    }),
  );
  idempotency.findOne.mockResolvedValue(null);
  seriesRepository.findOne.mockResolvedValue(series());

  return {
    dataSource,
    document,
    grant,
    history,
    idempotency,
    issuer,
    line,
    manager,
    outbox,
    series: seriesRepository,
    service: new FiscalDocumentsService(dataSource),
    transaction,
  };
}

function repositoryDouble<T extends object>(
  constructor: EntityConstructor<T>,
): RepositoryDouble<T> {
  return {
    create: jest.fn((values: Partial<T>): T => entity(constructor, values)),
    find: jest.fn((): Promise<T[]> => Promise.resolve([])),
    findOne: jest.fn((): Promise<T | null> => Promise.resolve(null)),
    save: jest.fn((value: T | T[]): Promise<T | T[]> => Promise.resolve(value)),
  };
}

function entity<T extends object>(constructor: EntityConstructor<T>, values: Partial<T>): T {
  return Object.assign(new constructor(), values);
}

function savedEntity<T extends object>(repository: RepositoryDouble<T>): T {
  const saved = repository.save.mock.calls.at(-1)?.[0];
  if (!saved || Array.isArray(saved)) {
    throw new Error('Expected one saved entity');
  }
  return saved;
}

function savedEntityAt<T extends object>(repository: RepositoryDouble<T>, callIndex: number): T {
  const saved = repository.save.mock.calls[callIndex]?.[0];
  if (!saved || Array.isArray(saved)) {
    throw new Error('Expected one saved entity at call index');
  }
  return saved;
}

function activeIssuer(): IssuerEntity {
  return entity(IssuerEntity, {
    active: true,
    address: { countryCode: 'PE' },
    id: ISSUER_ID,
    legalName: 'ACME SAC',
    organizationId: PRINCIPAL.organizationId,
    ruc: '20123456789',
    tradeName: 'ACME',
  });
}

function series(overrides: Partial<IssuerSeriesEntity> = {}): IssuerSeriesEntity {
  return entity(IssuerSeriesEntity, {
    active: true,
    documentType: '01',
    id: SERIES_ID,
    issuerId: ISSUER_ID,
    nextNumber: '41',
    series: 'F001',
    ...overrides,
  });
}

function invoiceInput(
  overrides: Partial<CreateFiscalDocumentInput> = {},
): CreateFiscalDocumentInput {
  return {
    currency: 'PEN',
    customer: {
      identityNumber: '20600000001',
      identityType: '6',
      legalName: 'CLIENTE SAC',
    },
    documentType: '01',
    issuerId: ISSUER_ID,
    issueDate: '2026-08-22',
    lines: [
      {
        description: 'Servicio mensual',
        discountAmount: '10',
        quantity: '2',
        taxAffectation: 'taxed',
        taxRate: '0.18',
        unitCode: 'NIU',
        unitValue: '100',
      },
    ],
    seriesId: SERIES_ID,
    ...overrides,
  };
}

function noteInput(reference: FiscalDocumentEntity): CreateFiscalDocumentInput {
  return invoiceInput({
    documentType: '07',
    reference: {
      documentId: reference.id,
      documentType: '01',
      number: reference.number,
      reasonCode: '01',
      reasonDescription: 'Anulación de la operación',
      series: reference.series,
    },
  });
}

function fiscalDocument(overrides: Partial<FiscalDocumentEntity> = {}): FiscalDocumentEntity {
  return entity(FiscalDocumentEntity, {
    acceptedAt: null,
    currency: 'PEN',
    customerSnapshot: {},
    documentType: '01',
    fiscalSnapshot: {},
    id: '99999999-9999-4999-8999-999999999999',
    issueDate: '2026-08-22',
    issuerId: ISSUER_ID,
    number: '8',
    organizationId: PRINCIPAL.organizationId,
    referenceDocumentId: null,
    series: 'F001',
    seriesId: SERIES_ID,
    snapshotSha256: 'f'.repeat(64),
    status: 'queued',
    totals: { currency: 'PEN', payableAmount: '118.00' },
    voidedAt: null,
    ...overrides,
  });
}
