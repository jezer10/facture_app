import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import type { FiscalDocumentType } from '@app/contracts';
import { canonicalJson, sha256 } from '@app/platform';
import type { BillingPrincipal } from '../auth';
import {
  IssuerEntity,
  OutboxEventEntity,
  ReceivedDocumentEntity,
  ReceivedSyncEntity,
  ServiceAccountIssuerGrantEntity,
} from '../database/entities';

export interface RequestReceivedSyncCommand {
  readonly idempotencyKey: string;
  readonly issuerId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly documentTypes: readonly FiscalDocumentType[];
}

export interface ReceivedSyncView {
  readonly createdAt: Date;
  readonly endDate: string;
  readonly id: string;
  readonly issuerId: string;
  readonly organizationId: string;
  readonly resultSummary: Readonly<Record<string, unknown>>;
  readonly startDate: string;
  readonly status: ReceivedSyncEntity['status'];
  readonly updatedAt: Date;
}

interface PreparedReceivedSync {
  readonly documentTypes: readonly FiscalDocumentType[];
  readonly endDate: string;
  readonly idempotencyKey: string;
  readonly issuerId: string;
  readonly requestSha256: string;
  readonly startDate: string;
}

const RECEIVED_DOCUMENT_TYPES: ReadonlySet<string> = new Set(['01', '03', '07', '08']);

@Injectable()
export class ReceivedDocumentsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async requestSync(
    principal: BillingPrincipal,
    command: RequestReceivedSyncCommand,
    correlationId: string,
  ): Promise<ReceivedSyncView> {
    const organizationId = requireOrganization(principal);
    const prepared = prepareReceivedSync(command);

    try {
      return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
        await assertIssuerAccess(manager, principal, organizationId, prepared.issuerId);
        const syncRepository = manager.getRepository(ReceivedSyncEntity);
        const existing = await syncRepository.findOne({
          where: {
            organizationId,
            issuerId: prepared.issuerId,
            idempotencyKey: prepared.idempotencyKey,
          },
        });
        if (existing) {
          return toSyncView(resolveExistingSync(existing, prepared.requestSha256));
        }

        const sync = await syncRepository.save(
          syncRepository.create({
            id: randomUUID(),
            organizationId,
            issuerId: prepared.issuerId,
            startDate: prepared.startDate,
            endDate: prepared.endDate,
            idempotencyKey: prepared.idempotencyKey,
            requestSha256: prepared.requestSha256,
            status: 'queued',
            resultSummary: {},
          }),
        );
        const outboxRepository = manager.getRepository(OutboxEventEntity);
        await outboxRepository.save(
          outboxRepository.create({
            eventId: randomUUID(),
            aggregateType: 'received-sync',
            aggregateId: sync.id,
            eventType: 'sunat.received.sync.requested.v1',
            organizationId,
            issuerId: prepared.issuerId,
            correlationId,
            payload: { documentTypes: prepared.documentTypes },
            status: 'pending',
            attempts: 0,
            availableAt: new Date(),
            lockedUntil: null,
            lastErrorCode: null,
          }),
        );
        return toSyncView(sync);
      });
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.dataSource.getRepository(ReceivedSyncEntity).findOne({
        where: {
          organizationId,
          issuerId: prepared.issuerId,
          idempotencyKey: prepared.idempotencyKey,
        },
      });
      if (!existing) {
        throw error;
      }
      return toSyncView(resolveExistingSync(existing, prepared.requestSha256));
    }
  }

  async getSync(principal: BillingPrincipal, syncId: string): Promise<ReceivedSyncView> {
    const sync = await this.dataSource.getRepository(ReceivedSyncEntity).findOneBy({
      id: syncId,
      organizationId: requireOrganization(principal),
    });
    if (!sync) {
      throw new NotFoundException('Received-document sync was not found');
    }
    if (!(await this.hasIssuerAccess(principal, sync.issuerId))) {
      throw new NotFoundException('Received-document sync was not found');
    }
    return toSyncView(sync);
  }

  async getReceivedDocument(
    principal: BillingPrincipal,
    documentId: string,
  ): Promise<ReceivedDocumentEntity> {
    const document = await this.dataSource.getRepository(ReceivedDocumentEntity).findOneBy({
      id: documentId,
      organizationId: requireOrganization(principal),
    });
    if (!document || !(await this.hasIssuerAccess(principal, document.recipientIssuerId))) {
      throw new NotFoundException('Received document was not found');
    }
    return document;
  }

  async list(
    principal: BillingPrincipal,
    limit: number,
    offset: number,
  ): Promise<ReceivedDocumentEntity[]> {
    const organizationId = requireOrganization(principal);
    const accessibleIssuerIds = await this.accessibleIssuerIds(principal);
    if (accessibleIssuerIds?.length === 0) {
      return [];
    }
    return this.dataSource.getRepository(ReceivedDocumentEntity).find({
      where: {
        organizationId,
        ...(accessibleIssuerIds ? { recipientIssuerId: In(accessibleIssuerIds) } : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: Math.min(limit, 100),
      skip: offset,
    });
  }

  private async hasIssuerAccess(principal: BillingPrincipal, issuerId: string): Promise<boolean> {
    if (principal.kind === 'human') {
      return true;
    }
    return this.dataSource.getRepository(ServiceAccountIssuerGrantEntity).existsBy({
      organizationId: principal.organizationId,
      serviceAccountId: principal.serviceAccountId,
      issuerId,
    });
  }

  private async accessibleIssuerIds(
    principal: BillingPrincipal,
  ): Promise<readonly string[] | undefined> {
    if (principal.kind === 'human') {
      return undefined;
    }
    const grants = await this.dataSource.getRepository(ServiceAccountIssuerGrantEntity).find({
      where: {
        organizationId: principal.organizationId,
        serviceAccountId: principal.serviceAccountId,
      },
      select: { issuerId: true },
    });
    return grants.map((grant) => grant.issuerId);
  }
}

function toSyncView(sync: ReceivedSyncEntity): ReceivedSyncView {
  return {
    createdAt: sync.createdAt,
    endDate: sync.endDate,
    id: sync.id,
    issuerId: sync.issuerId,
    organizationId: sync.organizationId,
    resultSummary: sync.resultSummary,
    startDate: sync.startDate,
    status: sync.status,
    updatedAt: sync.updatedAt,
  };
}

function prepareReceivedSync(command: RequestReceivedSyncCommand): PreparedReceivedSync {
  const idempotencyKey = normalizeIdempotencyKey(command.idempotencyKey);
  assertDateWindow(command.startDate, command.endDate);
  const documentTypes = normalizeDocumentTypes(command.documentTypes);
  const request = {
    documentTypes,
    endDate: command.endDate,
    issuerId: command.issuerId,
    startDate: command.startDate,
  };
  return {
    ...request,
    idempotencyKey,
    requestSha256: sha256(canonicalJson(request)),
  };
}

function normalizeIdempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length === 0 || key.length > 180) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key must contain between 1 and 180 characters',
    });
  }
  return key;
}

function normalizeDocumentTypes(
  values: readonly FiscalDocumentType[],
): readonly FiscalDocumentType[] {
  if (values.length === 0 || values.some((value) => !RECEIVED_DOCUMENT_TYPES.has(value))) {
    throw new BadRequestException('documentTypes must contain supported fiscal document types');
  }
  return [...new Set(values)].sort();
}

function resolveExistingSync(
  existing: ReceivedSyncEntity,
  requestSha256: string,
): ReceivedSyncEntity {
  if (existing.requestSha256 !== requestSha256) {
    throw new ConflictException({
      statusCode: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Idempotency-Key was already used with a different received-sync request',
    });
  }
  return existing;
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

async function assertIssuerAccess(
  manager: EntityManager,
  principal: BillingPrincipal,
  organizationId: string,
  issuerId: string,
): Promise<void> {
  const issuer = await manager.findOneBy(IssuerEntity, {
    id: issuerId,
    organizationId,
    active: true,
  });
  if (!issuer) {
    throw new NotFoundException('Issuer was not found in this organization');
  }
  if (principal.kind === 'service') {
    const grant = await manager.existsBy(ServiceAccountIssuerGrantEntity, {
      organizationId,
      serviceAccountId: principal.serviceAccountId,
      issuerId,
    });
    if (!grant) {
      throw new ForbiddenException('Service account is not authorized for this issuer');
    }
  }
}

function assertDateWindow(startDate: string, endDate: string): void {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (start > end) {
    throw new BadRequestException('startDate must not be after endDate');
  }
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > 15) {
    throw new BadRequestException('Received-document syncs are limited to 15 inclusive days');
  }
  const limaToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  if (endDate > limaToday) {
    throw new BadRequestException('endDate cannot be in the future for America/Lima');
  }
}

function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new BadRequestException('Dates must use YYYY-MM-DD');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('Date is not a real calendar date');
  }
  return date;
}

function requireOrganization(principal: BillingPrincipal): string {
  if (!principal.organizationId) {
    throw new ForbiddenException('An organization context is required');
  }
  return principal.organizationId;
}
