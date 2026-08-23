import { randomUUID } from 'node:crypto';

import type { CreateFiscalDocumentInput, FiscalDocumentLineInput } from '@app/contracts';
import {
  assertDocumentStatusTransition,
  calculateFiscalDocument,
  canonicalDecimal,
  createImmutableSnapshot,
  isEligibleNoteReferenceStatus,
  parseDecimal,
} from '@app/fiscal-domain';
import type {
  CalculatedFiscalDocument,
  CalculatedFiscalLine,
  FiscalDocumentInput as DomainFiscalDocumentInput,
  FiscalLineInput as DomainFiscalLineInput,
} from '@app/fiscal-domain';
import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { EntityManager, FindOptionsWhere } from 'typeorm';

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
  CorrelativeExhaustedError,
  FiscalDocumentNotFoundError,
  FiscalSeriesUnavailableError,
  IdempotencyConflictError,
  IdempotencyResourceMissingError,
  InvalidFiscalDocumentStateError,
  InvalidFiscalRequestError,
  InvalidReferenceDocumentError,
  IssuerAccessDeniedError,
  IssuerUnavailableError,
} from './fiscal-documents.errors';
import type {
  CreateFiscalDocumentCommand,
  FiscalDocumentsPrincipal,
  FiscalDocumentView,
  ListFiscalDocumentsQuery,
  RequestFiscalDocumentVoidCommand,
} from './fiscal-documents.types';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_CORRELATIVE = BigInt('9223372036854775807');

interface PreparedCreation {
  readonly calculated: CalculatedFiscalDocument;
  readonly input: CreateFiscalDocumentInput;
  readonly requestSha256: string;
}

interface AllocatedSeriesNumber {
  readonly number: string;
  readonly series: IssuerSeriesEntity;
}

@Injectable()
export class FiscalDocumentsService {
  constructor(private readonly dataSource: DataSource) {}

  async create(
    principal: FiscalDocumentsPrincipal,
    command: CreateFiscalDocumentCommand,
  ): Promise<FiscalDocumentView> {
    const idempotencyKey = normalizeIdempotencyKey(command.idempotencyKey);
    const prepared = prepareCreation(command.input);

    try {
      return await this.dataSource.transaction('SERIALIZABLE', (manager) =>
        this.createInTransaction(manager, principal, idempotencyKey, prepared),
      );
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) {
        throw error;
      }
      return this.resolveConcurrentIdempotency(
        principal,
        idempotencyKey,
        prepared.requestSha256,
        error,
      );
    }
  }

  async get(principal: FiscalDocumentsPrincipal, documentId: string): Promise<FiscalDocumentView> {
    const document = await this.dataSource.getRepository(FiscalDocumentEntity).findOne({
      where: { id: documentId, organizationId: principal.organizationId },
    });
    if (!document) {
      throw new FiscalDocumentNotFoundError(documentId);
    }

    const hasAccess = await this.hasIssuerAccess(
      this.dataSource.manager,
      principal,
      document.issuerId,
    );
    if (!hasAccess) {
      throw new FiscalDocumentNotFoundError(documentId);
    }
    return toView(document);
  }

  async list(
    principal: FiscalDocumentsPrincipal,
    query: ListFiscalDocumentsQuery = {},
  ): Promise<readonly FiscalDocumentView[]> {
    const { limit, offset } = normalizeListPagination(query);
    const accessibleIssuerIds = await this.listAccessibleIssuerIds(principal);
    if (accessibleIssuerIds !== undefined) {
      if (accessibleIssuerIds.length === 0) {
        return [];
      }
      if (query.issuerId && !accessibleIssuerIds.includes(query.issuerId)) {
        return [];
      }
    }

    const where: FindOptionsWhere<FiscalDocumentEntity> = {
      organizationId: principal.organizationId,
      ...(query.issuerId
        ? { issuerId: query.issuerId }
        : accessibleIssuerIds
          ? { issuerId: In(accessibleIssuerIds) }
          : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const documents = await this.dataSource.getRepository(FiscalDocumentEntity).find({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: offset,
      take: limit,
    });
    return documents.map(toView);
  }

  async requestVoid(
    principal: FiscalDocumentsPrincipal,
    command: RequestFiscalDocumentVoidCommand,
  ): Promise<FiscalDocumentView> {
    const reason = normalizeVoidReason(command.reason);
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const documentRepository = manager.getRepository(FiscalDocumentEntity);
      const document = await documentRepository.findOne({
        where: {
          id: command.documentId,
          organizationId: principal.organizationId,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!document || !(await this.hasIssuerAccess(manager, principal, document.issuerId))) {
        throw new FiscalDocumentNotFoundError(command.documentId);
      }
      if (document.status !== 'accepted' && document.status !== 'accepted_with_observations') {
        throw new InvalidFiscalDocumentStateError(document.id, document.status);
      }

      const previousStatus = document.status;
      assertDocumentStatusTransition(previousStatus, 'void_pending');
      document.status = 'void_pending';
      await documentRepository.save(document);

      const now = new Date();
      await manager.getRepository(DocumentStateHistoryEntity).save(
        manager.getRepository(DocumentStateHistoryEntity).create({
          documentId: document.id,
          fromStatus: previousStatus,
          toStatus: 'void_pending',
          reason: 'void_requested',
          metadata: {
            reason,
            ...principalAuditMetadata(principal),
          },
        }),
      );
      await manager.getRepository(OutboxEventEntity).save(
        createOutboxEvent(manager, {
          aggregateId: document.id,
          correlationId: principal.correlationId,
          eventType: 'sunat.document.void.requested.v1',
          issuerId: document.issuerId,
          organizationId: principal.organizationId,
          payload: {
            documentId: document.id,
            documentType: document.documentType,
            number: document.number,
            reason,
            series: document.series,
          },
          now,
        }),
      );

      return toView(document);
    });
  }

  private async createInTransaction(
    manager: EntityManager,
    principal: FiscalDocumentsPrincipal,
    idempotencyKey: string,
    prepared: PreparedCreation,
  ): Promise<FiscalDocumentView> {
    const issuer = await this.loadAuthorizedIssuer(manager, principal, prepared.input.issuerId);
    const existing = await manager.getRepository(IdempotencyRequestEntity).findOne({
      where: { organizationId: principal.organizationId, key: idempotencyKey },
    });
    if (existing) {
      return this.resolveExistingIdempotency(
        manager,
        principal.organizationId,
        idempotencyKey,
        prepared.requestSha256,
        existing,
      );
    }
    if (!issuer.active) {
      throw new IssuerUnavailableError(issuer.id);
    }

    const referencedDocument = await loadAndValidateReference(
      manager,
      principal.organizationId,
      issuer.id,
      prepared.input,
    );
    const allocated = await allocateSeriesNumber(manager, issuer.id, prepared.input);
    const documentId = randomUUID();
    const snapshots = buildSnapshots(issuer, allocated, prepared.input, prepared.calculated);
    const now = new Date();
    const documentRepository = manager.getRepository(FiscalDocumentEntity);
    const document = documentRepository.create({
      acceptedAt: null,
      currency: prepared.input.currency,
      customerSnapshot: snapshots.customer,
      documentType: prepared.input.documentType,
      fiscalSnapshot: snapshots.fiscal,
      id: documentId,
      issueDate: prepared.input.issueDate,
      issuerId: issuer.id,
      number: allocated.number,
      organizationId: principal.organizationId,
      referenceDocumentId: referencedDocument?.id ?? null,
      series: allocated.series.series,
      seriesId: allocated.series.id,
      snapshotSha256: snapshots.sha256,
      status: 'queued',
      totals: snapshots.totals,
      voidedAt: null,
    });

    await manager.getRepository(IssuerSeriesEntity).save(allocated.series);
    await documentRepository.save(document);
    const lineRepository = manager.getRepository(FiscalDocumentLineEntity);
    await lineRepository.save(
      snapshots.lines.map((snapshot, index) =>
        lineRepository.create({
          documentId,
          lineNumber: index + 1,
          snapshot,
        }),
      ),
    );
    await manager.getRepository(DocumentStateHistoryEntity).save(
      manager.getRepository(DocumentStateHistoryEntity).create({
        documentId,
        fromStatus: null,
        metadata: {
          ...principalAuditMetadata(principal),
        },
        reason: 'document_created',
        toStatus: 'queued',
      }),
    );
    await manager.getRepository(OutboxEventEntity).save(
      createOutboxEvent(manager, {
        aggregateId: documentId,
        correlationId: principal.correlationId,
        eventType: 'sunat.document.issue.requested.v1',
        issuerId: issuer.id,
        organizationId: principal.organizationId,
        payload: {
          documentId,
          documentType: prepared.input.documentType,
          number: allocated.number,
          series: allocated.series.series,
        },
        now,
      }),
    );
    const idempotencyRepository = manager.getRepository(IdempotencyRequestEntity);
    await idempotencyRepository.save(
      idempotencyRepository.create({
        key: idempotencyKey,
        organizationId: principal.organizationId,
        requestSha256: prepared.requestSha256,
        resourceId: documentId,
        resourceType: 'fiscal_document',
      }),
    );

    return toView(document);
  }

  private async loadAuthorizedIssuer(
    manager: EntityManager,
    principal: FiscalDocumentsPrincipal,
    issuerId: string,
  ): Promise<IssuerEntity> {
    const issuer = await manager.getRepository(IssuerEntity).findOne({
      where: { id: issuerId, organizationId: principal.organizationId },
    });
    const hasAccess = await this.hasIssuerAccess(manager, principal, issuerId);
    if (!issuer || !hasAccess) {
      throw new IssuerAccessDeniedError(issuerId);
    }
    return issuer;
  }

  private async hasIssuerAccess(
    manager: EntityManager,
    principal: FiscalDocumentsPrincipal,
    issuerId: string,
  ): Promise<boolean> {
    if (principal.serviceAccountId === undefined) {
      return true;
    }
    const grant = await manager.getRepository(ServiceAccountIssuerGrantEntity).findOne({
      where: {
        issuerId,
        organizationId: principal.organizationId,
        serviceAccountId: principal.serviceAccountId,
      },
    });
    return grant !== null && grant !== undefined;
  }

  private async listAccessibleIssuerIds(
    principal: FiscalDocumentsPrincipal,
  ): Promise<readonly string[] | undefined> {
    if (principal.serviceAccountId === undefined) {
      return undefined;
    }
    const grants = await this.dataSource.getRepository(ServiceAccountIssuerGrantEntity).find({
      where: {
        organizationId: principal.organizationId,
        serviceAccountId: principal.serviceAccountId,
      },
    });
    return grants.map((grant) => grant.issuerId);
  }

  private async resolveExistingIdempotency(
    manager: EntityManager,
    organizationId: string,
    idempotencyKey: string,
    requestSha256: string,
    existing: IdempotencyRequestEntity,
  ): Promise<FiscalDocumentView> {
    if (existing.requestSha256 !== requestSha256) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    const document = await manager.getRepository(FiscalDocumentEntity).findOne({
      where: { id: existing.resourceId, organizationId },
    });
    if (!document) {
      throw new IdempotencyResourceMissingError(existing.resourceId);
    }
    return toView(document);
  }

  private async resolveConcurrentIdempotency(
    principal: FiscalDocumentsPrincipal,
    idempotencyKey: string,
    requestSha256: string,
    originalError: unknown,
  ): Promise<FiscalDocumentView> {
    const existing = await this.dataSource.getRepository(IdempotencyRequestEntity).findOne({
      where: { organizationId: principal.organizationId, key: idempotencyKey },
    });
    if (!existing) {
      throw originalError;
    }
    return this.resolveExistingIdempotency(
      this.dataSource.manager,
      principal.organizationId,
      idempotencyKey,
      requestSha256,
      existing,
    );
  }
}
function prepareCreation(input: CreateFiscalDocumentInput): PreparedCreation {
  const plainInput = toPlainCreateFiscalDocumentInput(input);
  const domainInput = toDomainInput(plainInput);
  return {
    calculated: calculateFiscalDocument(domainInput),
    input: plainInput,
    requestSha256: createImmutableSnapshot(plainInput).sha256,
  };
}

function toPlainCreateFiscalDocumentInput(
  input: CreateFiscalDocumentInput,
): CreateFiscalDocumentInput {
  return {
    currency: input.currency,
    customer: toPlainFiscalParty(input.customer),
    documentType: input.documentType,
    issuerId: input.issuerId,
    issueDate: input.issueDate,
    lines: Array.from(input.lines, toPlainFiscalLine),
    ...(input.notes === undefined ? {} : { notes: [...input.notes] }),
    ...(input.purchaseOrder === undefined ? {} : { purchaseOrder: input.purchaseOrder }),
    ...(input.reference === undefined
      ? {}
      : {
          reference: {
            documentId: input.reference.documentId,
            documentType: input.reference.documentType,
            number: input.reference.number,
            reasonCode: input.reference.reasonCode,
            reasonDescription: input.reference.reasonDescription,
            series: input.reference.series,
          },
        }),
    seriesId: input.seriesId,
  };
}

function toPlainFiscalParty(
  party: CreateFiscalDocumentInput['customer'],
): CreateFiscalDocumentInput['customer'] {
  return {
    ...(party.address === undefined
      ? {}
      : {
          address: {
            ...(party.address.countryCode === undefined
              ? {}
              : { countryCode: party.address.countryCode }),
            ...(party.address.department === undefined
              ? {}
              : { department: party.address.department }),
            ...(party.address.district === undefined ? {} : { district: party.address.district }),
            line: party.address.line,
            ...(party.address.province === undefined ? {} : { province: party.address.province }),
            ...(party.address.ubigeo === undefined ? {} : { ubigeo: party.address.ubigeo }),
          },
        }),
    ...(party.email === undefined ? {} : { email: party.email }),
    identityNumber: party.identityNumber,
    identityType: party.identityType,
    legalName: party.legalName,
    ...(party.tradeName === undefined ? {} : { tradeName: party.tradeName }),
  };
}

function toPlainFiscalLine(line: FiscalDocumentLineInput): FiscalDocumentLineInput {
  return {
    description: line.description,
    ...(line.discountAmount === undefined ? {} : { discountAmount: line.discountAmount }),
    ...(line.freeTaxTreatment === undefined ? {} : { freeTaxTreatment: line.freeTaxTreatment }),
    ...(line.itemCode === undefined ? {} : { itemCode: line.itemCode }),
    quantity: line.quantity,
    ...(line.referenceUnitValue === undefined
      ? {}
      : { referenceUnitValue: line.referenceUnitValue }),
    taxAffectation: line.taxAffectation,
    taxRate: line.taxRate,
    unitCode: line.unitCode,
    unitValue: line.unitValue,
  };
}

function toDomainInput(input: CreateFiscalDocumentInput): DomainFiscalDocumentInput {
  return {
    currency: input.currency,
    documentType: input.documentType,
    issueDate: input.issueDate,
    lines: input.lines.map(toDomainLine),
    ...(input.reference
      ? {
          noteReference: {
            document: {
              documentType: input.reference.documentType,
              number: input.reference.number,
              series: input.reference.series,
            },
            reason: input.reference.reasonDescription,
            reasonCode: input.reference.reasonCode,
          },
        }
      : {}),
  };
}

function toDomainLine(line: FiscalDocumentLineInput, index: number): DomainFiscalLineInput {
  const lineId = String(index + 1);

  switch (line.taxAffectation) {
    case 'taxed':
      return {
        description: line.description,
        igvRate: line.taxRate,
        lineId,
        quantity: line.quantity,
        taxCategory: 'TAXED',
        unitValue: netUnitValueAfterDiscount(line, index),
      };
    case 'exonerated':
      assertZeroTaxRate(line, index);
      return {
        description: line.description,
        lineId,
        quantity: line.quantity,
        taxCategory: 'EXONERATED',
        unitValue: netUnitValueAfterDiscount(line, index),
      };
    case 'unaffected':
      assertZeroTaxRate(line, index);
      return {
        description: line.description,
        lineId,
        quantity: line.quantity,
        taxCategory: 'UNAFFECTED',
        unitValue: netUnitValueAfterDiscount(line, index),
      };
    case 'free': {
      assertNoFreeLineDiscount(line, index);
      const freeTaxTreatment = mapFreeTaxTreatment(line.freeTaxTreatment, index);
      if (line.referenceUnitValue === undefined) {
        throw new InvalidFiscalRequestError(
          'INVALID_FREE_LINE',
          `lines[${index}].referenceUnitValue is required for a free operation`,
        );
      }
      if (freeTaxTreatment !== 'TAXED') {
        assertZeroTaxRate(line, index);
      }
      return {
        description: line.description,
        ...(freeTaxTreatment === 'TAXED' ? { igvRate: line.taxRate } : {}),
        freeTaxTreatment,
        lineId,
        quantity: line.quantity,
        referenceUnitValue: line.referenceUnitValue,
        taxCategory: 'FREE',
      };
    }
  }
}

function assertZeroTaxRate(line: FiscalDocumentLineInput, index: number): void {
  const rate = parseDecimal(line.taxRate, `lines[${index}].taxRate`);
  if (!rate.isZero()) {
    throw new InvalidFiscalRequestError(
      'INVALID_TAX_RATE',
      `lines[${index}].taxRate must be zero for a non-taxed operation`,
    );
  }
}

function mapFreeTaxTreatment(
  value: FiscalDocumentLineInput['freeTaxTreatment'],
  index: number,
): 'TAXED' | 'EXONERATED' | 'UNAFFECTED' {
  switch (value) {
    case 'taxed':
      return 'TAXED';
    case 'exonerated':
      return 'EXONERATED';
    case 'unaffected':
      return 'UNAFFECTED';
    default:
      throw new InvalidFiscalRequestError(
        'INVALID_FREE_LINE',
        `lines[${index}].freeTaxTreatment is required for a free operation`,
      );
  }
}

function netUnitValueAfterDiscount(line: FiscalDocumentLineInput, index: number): string {
  if (line.discountAmount === undefined) {
    return line.unitValue;
  }
  const quantity = parseDecimal(line.quantity, `lines[${index}].quantity`);
  const unitValue = parseDecimal(line.unitValue, `lines[${index}].unitValue`);
  const discount = parseDecimal(line.discountAmount, `lines[${index}].discountAmount`);
  const gross = quantity.times(unitValue);
  if (!quantity.greaterThan(0) || discount.isNegative() || discount.greaterThan(gross)) {
    throw new InvalidFiscalRequestError(
      'INVALID_LINE_DISCOUNT',
      `lines[${index}].discountAmount must be between zero and the gross line amount`,
    );
  }
  return canonicalDecimal(gross.minus(discount).dividedBy(quantity));
}

function assertNoFreeLineDiscount(line: FiscalDocumentLineInput, index: number): void {
  if (
    line.discountAmount !== undefined &&
    !parseDecimal(line.discountAmount, `lines[${index}].discountAmount`).isZero()
  ) {
    throw new InvalidFiscalRequestError(
      'INVALID_LINE_DISCOUNT',
      `lines[${index}].discountAmount is not valid for a free operation`,
    );
  }
}

async function loadAndValidateReference(
  manager: EntityManager,
  organizationId: string,
  issuerId: string,
  input: CreateFiscalDocumentInput,
): Promise<FiscalDocumentEntity | undefined> {
  if (input.documentType !== '07' && input.documentType !== '08') {
    return undefined;
  }
  if (!input.reference) {
    throw new InvalidReferenceDocumentError('Credit and debit notes require a reference');
  }

  const reference = await manager.getRepository(FiscalDocumentEntity).findOne({
    where: { id: input.reference.documentId, organizationId },
    lock: { mode: 'pessimistic_read' },
  });
  if (
    !reference ||
    reference.issuerId !== issuerId ||
    reference.documentType !== input.reference.documentType ||
    reference.series !== input.reference.series ||
    reference.number !== input.reference.number
  ) {
    throw new InvalidReferenceDocumentError(
      'Referenced document identity does not match an original document for this issuer',
    );
  }
  if (!isEligibleNoteReferenceStatus(reference.status)) {
    throw new InvalidReferenceDocumentError(
      `Referenced document must be accepted; current status is ${reference.status}`,
    );
  }
  return reference;
}

async function allocateSeriesNumber(
  manager: EntityManager,
  issuerId: string,
  input: CreateFiscalDocumentInput,
): Promise<AllocatedSeriesNumber> {
  const repository = manager.getRepository(IssuerSeriesEntity);
  const series = await repository.findOne({
    where: {
      active: true,
      documentType: input.documentType,
      id: input.seriesId,
      issuerId,
    },
    lock: { mode: 'pessimistic_write' },
  });
  if (!series) {
    throw new FiscalSeriesUnavailableError(input.seriesId);
  }
  if (!/^[1-9]\d*$/u.test(series.nextNumber)) {
    throw new CorrelativeExhaustedError(series.id);
  }

  const current = BigInt(series.nextNumber);
  if (current >= MAX_CORRELATIVE) {
    throw new CorrelativeExhaustedError(series.id);
  }
  series.nextNumber = (current + 1n).toString();
  return { number: current.toString(), series };
}

function buildSnapshots(
  issuer: IssuerEntity,
  allocated: AllocatedSeriesNumber,
  input: CreateFiscalDocumentInput,
  calculated: CalculatedFiscalDocument,
): {
  readonly customer: Record<string, unknown>;
  readonly fiscal: Record<string, unknown>;
  readonly lines: readonly Record<string, unknown>[];
  readonly sha256: string;
  readonly totals: Record<string, string>;
} {
  const customer = canonicalRecord(input.customer);
  const lines = calculated.lines.map((line, index) => buildLineSnapshot(input.lines[index]!, line));
  const totals = totalsRecord(calculated);
  const fiscalContent = {
    currency: input.currency,
    customer,
    documentType: input.documentType,
    issueDate: input.issueDate,
    issuer: {
      address: issuer.address,
      legalName: issuer.legalName,
      ruc: issuer.ruc,
      tradeName: issuer.tradeName,
    },
    lines,
    number: allocated.number,
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.purchaseOrder ? { purchaseOrder: input.purchaseOrder } : {}),
    ...(calculated.noteReference ? { noteReference: calculated.noteReference } : {}),
    series: allocated.series.series,
    totals,
  };
  const snapshot = createImmutableSnapshot(fiscalContent);

  return {
    customer,
    fiscal: canonicalRecord(snapshot.data),
    lines,
    sha256: snapshot.sha256,
    totals,
  };
}

function buildLineSnapshot(
  input: FiscalDocumentLineInput,
  calculated: CalculatedFiscalLine,
): Record<string, unknown> {
  return canonicalRecord({
    ...(input.discountAmount ? { discountAmount: input.discountAmount } : {}),
    ...(input.itemCode ? { itemCode: input.itemCode } : {}),
    description: calculated.description,
    exoneratedAmount: calculated.exoneratedAmount.toString(),
    freeAmount: calculated.freeAmount.toString(),
    freeIgvAmount: calculated.freeIgvAmount.toString(),
    igvAmount: calculated.igvAmount.toString(),
    ...(calculated.igvRate ? { igvRate: calculated.igvRate } : {}),
    lineId: calculated.lineId,
    payableAmount: calculated.payableAmount.toString(),
    quantity: calculated.quantity,
    ...(calculated.referenceUnitValue ? { referenceUnitValue: calculated.referenceUnitValue } : {}),
    taxAffectation: input.taxAffectation,
    taxRate: input.taxRate,
    taxableAmount: calculated.taxableAmount.toString(),
    unaffectedAmount: calculated.unaffectedAmount.toString(),
    unitCode: input.unitCode,
    unitValue: input.unitValue,
    ...(calculated.unitValue ? { netUnitValue: calculated.unitValue } : {}),
  });
}

function totalsRecord(document: CalculatedFiscalDocument): Record<string, string> {
  return Object.freeze({
    currency: document.currency,
    exoneratedAmount: document.totals.exoneratedAmount.toString(),
    freeAmount: document.totals.freeAmount.toString(),
    freeIgvAmount: document.totals.freeIgvAmount.toString(),
    igvAmount: document.totals.igvAmount.toString(),
    payableAmount: document.totals.payableAmount.toString(),
    taxableAmount: document.totals.taxableAmount.toString(),
    unaffectedAmount: document.totals.unaffectedAmount.toString(),
  });
}

function canonicalRecord(value: unknown): Record<string, unknown> {
  const canonical = createImmutableSnapshot(value).data;
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== 'object') {
    throw new TypeError('Expected a canonical JSON object');
  }
  return canonical as Record<string, unknown>;
}

function createOutboxEvent(
  manager: EntityManager,
  input: {
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly eventType: string;
    readonly issuerId: string;
    readonly now: Date;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  },
): OutboxEventEntity {
  return manager.getRepository(OutboxEventEntity).create({
    aggregateId: input.aggregateId,
    aggregateType: 'fiscal_document',
    attempts: 0,
    availableAt: input.now,
    correlationId: input.correlationId,
    eventId: randomUUID(),
    eventType: input.eventType,
    issuerId: input.issuerId,
    lastErrorCode: null,
    lockedUntil: null,
    organizationId: input.organizationId,
    payload: input.payload,
    status: 'pending',
  });
}

function principalAuditMetadata(
  principal: FiscalDocumentsPrincipal,
): Readonly<Record<string, string>> {
  if (principal.serviceAccountId !== undefined) {
    return Object.freeze({
      actorId: principal.serviceAccountId,
      actorType: 'service',
      correlationId: principal.correlationId,
    });
  }
  return Object.freeze({
    actorId: principal.subject,
    actorType: 'human',
    correlationId: principal.correlationId,
  });
}

function normalizeIdempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length === 0 || key.length > 180) {
    throw new InvalidFiscalRequestError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency key must contain between 1 and 180 characters',
    );
  }
  return key;
}

function normalizeVoidReason(value: string): string {
  const reason = value.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new InvalidFiscalRequestError(
      'INVALID_VOID_REASON',
      'Void reason must contain between 1 and 500 characters',
    );
  }
  return reason;
}

function normalizeListPagination(query: ListFiscalDocumentsQuery): {
  readonly limit: number;
  readonly offset: number;
} {
  const limit = query.limit ?? DEFAULT_LIST_LIMIT;
  const offset = query.offset ?? 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new InvalidFiscalRequestError(
      'INVALID_LIST_QUERY',
      `List pagination requires limit 1-${MAX_LIST_LIMIT} and a non-negative offset`,
    );
  }
  return { limit, offset };
}

function toView(document: FiscalDocumentEntity): FiscalDocumentView {
  return Object.freeze({
    currency: document.currency,
    documentType: document.documentType,
    id: document.id,
    issuerId: document.issuerId,
    issueDate: document.issueDate,
    number: document.number,
    organizationId: document.organizationId,
    referenceDocumentId: document.referenceDocumentId,
    series: document.series,
    snapshotSha256: document.snapshotSha256,
    status: document.status,
    totals: Object.freeze({ ...document.totals }),
  });
}

function isPostgresUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  return candidate.code === '23505' || candidate.driverError?.code === '23505';
}
