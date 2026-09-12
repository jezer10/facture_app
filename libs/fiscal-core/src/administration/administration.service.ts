import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { FiscalDocumentType } from '@app/contracts';
import { canonicalJson, sha256 } from '@app/platform';
import { ApiKeyService } from '../auth/api-key.service';
import type { CreatedApiKey } from '../auth/api-key.service';
import type { ApiKeyScope, BillingPrincipal } from '../auth/auth.types';
import {
  ApiKeyCreationRequestEntity,
  AuditLogEntity,
  IssuerEntity,
  IssuerSeriesEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
  ServiceAccountEntity,
  ServiceAccountIssuerGrantEntity,
} from '../database/entities';
import { ApiKeyReplayService } from './api-key-replay.service';

export interface CreateOrganizationCommand {
  readonly name: string;
  readonly slug: string;
  readonly ownerSubject: string;
}

export interface CreateIssuerCommand {
  readonly ruc: string;
  readonly legalName: string;
  readonly tradeName?: string;
  readonly address?: Record<string, string>;
}

@Injectable()
export class AdministrationService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(IssuerEntity)
    private readonly issuers: Repository<IssuerEntity>,
    @InjectRepository(ServiceAccountIssuerGrantEntity)
    private readonly grants: Repository<ServiceAccountIssuerGrantEntity>,
    private readonly apiKeys: ApiKeyService,
    private readonly apiKeyReplays: ApiKeyReplayService,
  ) {}

  async createOrganization(
    command: CreateOrganizationCommand,
    actorSubject: string,
  ): Promise<OrganizationEntity> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const organizations = manager.getRepository(OrganizationEntity);
        const saved = await organizations.save(
          organizations.create({ name: command.name, slug: command.slug }),
        );
        const members = manager.getRepository(OrganizationMemberEntity);
        await members.save(
          members.create({
            organizationId: saved.id,
            subject: command.ownerSubject,
            role: 'owner',
          }),
        );
        await this.auditAsHuman(
          manager,
          saved.id,
          actorSubject,
          'organization.created',
          'organization',
          saved.id,
        );
        return saved;
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictException('Organization slug is already in use');
      }
      throw error;
    }
  }

  async createServiceAccount(
    organizationId: string,
    name: string,
    actor: BillingPrincipal,
  ): Promise<ServiceAccountEntity> {
    assertActorOrganization(organizationId, actor);
    return this.dataSource.transaction(async (manager) => {
      const serviceAccounts = manager.getRepository(ServiceAccountEntity);
      const account = await serviceAccounts.save(
        serviceAccounts.create({ organizationId, name, active: true }),
      );
      await this.audit(
        manager,
        organizationId,
        actor,
        'service-account.created',
        'service-account',
        account.id,
      );
      return account;
    });
  }

  async createIssuer(
    organizationId: string,
    command: CreateIssuerCommand,
    actor: BillingPrincipal,
  ): Promise<IssuerEntity> {
    assertActorOrganization(organizationId, actor);
    if (!isValidPeruvianRuc(command.ruc)) {
      throw new BadRequestException('RUC must be a valid 11-digit Peruvian taxpayer identifier');
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        const issuers = manager.getRepository(IssuerEntity);
        const issuer = await issuers.save(
          issuers.create({
            organizationId,
            ruc: command.ruc,
            legalName: command.legalName,
            tradeName: command.tradeName ?? null,
            address: command.address ?? {},
            active: true,
          }),
        );
        await this.audit(manager, organizationId, actor, 'issuer.created', 'issuer', issuer.id);
        return issuer;
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictException('RUC is already registered');
      }
      throw error;
    }
  }

  async createSeries(
    organizationId: string,
    issuerId: string,
    documentType: FiscalDocumentType,
    seriesName: string,
    nextNumber: number,
    actor: BillingPrincipal,
  ): Promise<IssuerSeriesEntity> {
    assertActorOrganization(organizationId, actor);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const issuer = await manager
          .getRepository(IssuerEntity)
          .findOneBy({ id: issuerId, organizationId, active: true });
        if (!issuer) {
          throw new NotFoundException('Issuer was not found in this organization');
        }
        const series = manager.getRepository(IssuerSeriesEntity);
        const created = await series.save(
          series.create({
            issuerId,
            documentType,
            series: seriesName,
            nextNumber: String(nextNumber),
            active: true,
          }),
        );
        await this.audit(
          manager,
          organizationId,
          actor,
          'issuer-series.created',
          'issuer-series',
          created.id,
        );
        return created;
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictException(
          'Series is already registered for this issuer and document type',
        );
      }
      throw error;
    }
  }

  async getIssuer(organizationId: string, issuerId: string): Promise<IssuerEntity> {
    const issuer = await this.issuers.findOneBy({
      id: issuerId,
      organizationId,
      active: true,
    });
    if (!issuer) {
      throw new NotFoundException('Active issuer was not found in this organization');
    }
    return issuer;
  }

  async getIssuerForPrincipal(
    principal: BillingPrincipal,
    issuerId: string,
  ): Promise<IssuerEntity> {
    if (!principal.organizationId) {
      throw new ForbiddenException('An organization context is required');
    }
    const issuer = await this.getIssuer(principal.organizationId, issuerId);
    if (principal.kind === 'service') {
      const hasGrant = await this.grants.existsBy({
        organizationId: principal.organizationId,
        serviceAccountId: principal.serviceAccountId,
        issuerId,
      });
      if (!hasGrant) {
        throw new ForbiddenException('Service account is not authorized for this issuer');
      }
    }
    return issuer;
  }

  async grantIssuer(
    organizationId: string,
    serviceAccountId: string,
    issuerId: string,
    actor: BillingPrincipal,
  ): Promise<ServiceAccountIssuerGrantEntity> {
    assertActorOrganization(organizationId, actor);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const account = await manager
          .getRepository(ServiceAccountEntity)
          .findOneBy({ id: serviceAccountId, organizationId, active: true });
        const issuer = await manager
          .getRepository(IssuerEntity)
          .findOneBy({ id: issuerId, organizationId, active: true });
        if (!account || !issuer) {
          throw new NotFoundException('Active service account or issuer was not found');
        }
        const grants = manager.getRepository(ServiceAccountIssuerGrantEntity);
        const existing = await grants.findOneBy({ organizationId, serviceAccountId, issuerId });
        if (existing) {
          return existing;
        }
        const grant = await grants.save(
          grants.create({ organizationId, serviceAccountId, issuerId }),
        );
        await this.audit(
          manager,
          organizationId,
          actor,
          'issuer-grant.created',
          'issuer-grant',
          grant.id,
        );
        return grant;
      });
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.grants.findOneBy({
        organizationId,
        serviceAccountId,
        issuerId,
      });
      if (!existing) {
        throw error;
      }
      return existing;
    }
  }

  async createApiKey(
    organizationId: string,
    serviceAccountId: string,
    scopes: readonly ApiKeyScope[],
    expiresAt: Date | null,
    actor: BillingPrincipal,
    idempotencyKey: string,
  ): Promise<CreatedApiKey> {
    assertActorOrganization(organizationId, actor);
    const prepared = prepareApiKeyCreation(serviceAccountId, scopes, expiresAt, idempotencyKey);
    try {
      return await this.dataSource.transaction((manager) =>
        this.createApiKeyInTransaction(manager, organizationId, serviceAccountId, actor, prepared),
      );
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        const replay = await this.resolveCommittedApiKeyCreation(
          organizationId,
          serviceAccountId,
          prepared,
        );
        if (replay) {
          return replay;
        }
      }
      throw error;
    }
  }

  async revokeApiKey(
    organizationId: string,
    apiKeyId: string,
    actor: BillingPrincipal,
  ): Promise<void> {
    assertActorOrganization(organizationId, actor);
    await this.dataSource.transaction(async (manager) => {
      await this.apiKeys.revoke(organizationId, apiKeyId, manager);
      await this.apiKeyReplays.clearForApiKey(manager, organizationId, apiKeyId);
      await this.audit(manager, organizationId, actor, 'api-key.revoked', 'api-key', apiKeyId);
    });
  }

  private async createApiKeyInTransaction(
    manager: EntityManager,
    organizationId: string,
    serviceAccountId: string,
    actor: BillingPrincipal,
    prepared: PreparedApiKeyCreation,
  ): Promise<CreatedApiKey> {
    const requests = manager.getRepository(ApiKeyCreationRequestEntity);
    const existing = await requests.findOne({
      where: { organizationId, idempotencyKey: prepared.idempotencyKey },
    });
    if (existing) {
      return this.resolveApiKeyCreation(manager, serviceAccountId, prepared, existing);
    }

    const created = await this.apiKeys.create(
      organizationId,
      serviceAccountId,
      prepared.scopes,
      prepared.expiresAt,
      { manager },
    );
    const sealedReplay = this.apiKeyReplays.seal(created, {
      apiKeyId: created.id,
      organizationId,
      requestSha256: prepared.requestSha256,
      serviceAccountId,
    });
    await requests.save(
      requests.create({
        organizationId,
        serviceAccountId,
        apiKeyId: created.id,
        idempotencyKey: prepared.idempotencyKey,
        requestSha256: prepared.requestSha256,
        ...sealedReplay,
      }),
    );
    await this.audit(manager, organizationId, actor, 'api-key.created', 'api-key', created.id, {
      prefix: created.prefix,
      scopes: created.scopes,
      expiresAt: created.expiresAt?.toISOString() ?? null,
    });
    return created;
  }

  private async resolveCommittedApiKeyCreation(
    organizationId: string,
    serviceAccountId: string,
    prepared: PreparedApiKeyCreation,
  ): Promise<CreatedApiKey | null> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.getRepository(ApiKeyCreationRequestEntity).findOne({
        where: { organizationId, idempotencyKey: prepared.idempotencyKey },
      });
      return existing
        ? this.resolveApiKeyCreation(manager, serviceAccountId, prepared, existing)
        : null;
    });
  }

  private async resolveApiKeyCreation(
    manager: EntityManager,
    serviceAccountId: string,
    prepared: PreparedApiKeyCreation,
    existing: ApiKeyCreationRequestEntity,
  ): Promise<CreatedApiKey> {
    if (
      existing.serviceAccountId !== serviceAccountId ||
      existing.requestSha256 !== prepared.requestSha256
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency-Key was already used with a different API-key request',
      });
    }
    const credential = this.apiKeyReplays.open(existing);
    return this.apiKeys.restoreIdempotentCreation(
      manager,
      existing.organizationId,
      existing.serviceAccountId,
      existing.apiKeyId,
      credential,
    );
  }

  private async audit(
    manager: EntityManager,
    organizationId: string,
    actor: BillingPrincipal,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const auditLog = manager.getRepository(AuditLogEntity);
    await auditLog.save(
      auditLog.create({
        organizationId,
        actorType: actor.kind,
        actorId: actor.kind === 'human' ? actor.subject : actor.serviceAccountId,
        action,
        resourceType,
        resourceId,
        metadata,
      }),
    );
  }

  private async auditAsHuman(
    manager: EntityManager,
    organizationId: string,
    actorSubject: string,
    action: string,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    const auditLog = manager.getRepository(AuditLogEntity);
    await auditLog.save(
      auditLog.create({
        organizationId,
        actorType: 'human',
        actorId: actorSubject,
        action,
        resourceType,
        resourceId,
        metadata: {},
      }),
    );
  }
}

interface PreparedApiKeyCreation {
  readonly expiresAt: Date | null;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly scopes: readonly ApiKeyScope[];
}

function prepareApiKeyCreation(
  serviceAccountId: string,
  scopes: readonly ApiKeyScope[],
  expiresAt: Date | null,
  idempotencyKey: string,
): PreparedApiKeyCreation {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) {
    throw new BadRequestException('expiresAt must be a valid date');
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'INVALID_API_KEY_EXPIRATION',
      message: 'expiresAt must be in the future',
    });
  }
  const normalizedScopes = [...new Set(scopes)].sort();
  const normalizedExpiresAt = expiresAt ? new Date(expiresAt.getTime()) : null;
  return {
    expiresAt: normalizedExpiresAt,
    idempotencyKey: normalizedKey,
    requestSha256: sha256(
      canonicalJson({
        expiresAt: normalizedExpiresAt?.toISOString() ?? null,
        scopes: normalizedScopes,
        serviceAccountId,
      }),
    ),
    scopes: normalizedScopes,
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

function assertActorOrganization(organizationId: string, actor: BillingPrincipal): void {
  if (actor.organizationId !== organizationId) {
    throw new ForbiddenException('Administrator organization does not match the target resource');
  }
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return postgresErrorCode(error) === '23505';
}

function postgresErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  return candidate.code ?? candidate.driverError?.code;
}

export function isValidPeruvianRuc(ruc: string): boolean {
  if (!/^(10|15|16|17|20)[0-9]{9}$/u.test(ruc)) {
    return false;
  }
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
  const sum = weights.reduce((total, weight, index) => total + Number(ruc[index]) * weight, 0);
  const remainder = 11 - (sum % 11);
  const expected = remainder === 10 ? 0 : remainder === 11 ? 1 : remainder;
  return expected === Number(ruc[10]);
}
