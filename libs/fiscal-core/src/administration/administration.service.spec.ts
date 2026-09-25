import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import type { ApiKeyService } from '../auth/api-key.service';
import type { CreatedApiKey } from '../auth/api-key.service';
import type { HumanPrincipal, MachinePrincipal } from '../auth/auth.types';
import {
  ApiKeyCreationRequestEntity,
  AuditLogEntity,
  IssuerEntity,
  ServiceAccountEntity,
} from '../database/entities';
import type { ServiceAccountIssuerGrantEntity } from '../database/entities';
import type { ApiKeyReplayService } from './api-key-replay.service';
import { AdministrationService, isValidPeruvianRuc } from './administration.service';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const ISSUER_ID = '33333333-3333-4333-8333-333333333333';
const SERVICE_ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const API_KEY_ID = '66666666-6666-4666-8666-666666666666';

const SERVICE_PRINCIPAL: MachinePrincipal = {
  kind: 'service',
  organizationId: ORGANIZATION_ID,
  serviceAccountId: SERVICE_ACCOUNT_ID,
  apiKeyId: '55555555-5555-4555-8555-555555555555',
  scopes: new Set(['issuers:manage']),
};

const ADMIN_PRINCIPAL: HumanPrincipal = {
  kind: 'human',
  subject: 'admin@example.test',
  organizationId: ORGANIZATION_ID,
  role: 'admin',
  platformAdmin: false,
};

describe('isValidPeruvianRuc', () => {
  it.each(['20131312955', '20552103816'])('accepts a valid RUC: %s', (ruc) => {
    expect(isValidPeruvianRuc(ruc)).toBe(true);
  });

  it.each(['20131312954', '123', '11111111111'])('rejects an invalid RUC: %s', (ruc) => {
    expect(isValidPeruvianRuc(ruc)).toBe(false);
  });
});

describe('AdministrationService.getIssuerForPrincipal', () => {
  it('allows a service account with an issuer grant in the same organization', async () => {
    const { grants, issuers, service } = createService();
    const issuer = activeIssuer();
    issuers.findOneBy.mockResolvedValue(issuer);
    grants.existsBy.mockResolvedValue(true);

    await expect(service.getIssuerForPrincipal(SERVICE_PRINCIPAL, ISSUER_ID)).resolves.toBe(issuer);

    expect(issuers.findOneBy).toHaveBeenCalledWith({
      id: ISSUER_ID,
      organizationId: ORGANIZATION_ID,
      active: true,
    });
    expect(grants.existsBy).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      serviceAccountId: SERVICE_ACCOUNT_ID,
      issuerId: ISSUER_ID,
    });
  });

  it('denies a service account without a grant for the issuer', async () => {
    const { grants, issuers, service } = createService();
    issuers.findOneBy.mockResolvedValue(activeIssuer());
    grants.existsBy.mockResolvedValue(false);

    await expect(
      service.getIssuerForPrincipal(SERVICE_PRINCIPAL, ISSUER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not reveal an issuer from another organization before checking grants', async () => {
    const { grants, issuers, service } = createService();
    issuers.findOneBy.mockResolvedValue(null);

    await expect(
      service.getIssuerForPrincipal(
        { ...SERVICE_PRINCIPAL, organizationId: OTHER_ORGANIZATION_ID },
        ISSUER_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(grants.existsBy).not.toHaveBeenCalled();
  });

  it('allows an organization administrator without requiring a service-account grant', async () => {
    const { grants, issuers, service } = createService();
    const issuer = activeIssuer();
    issuers.findOneBy.mockResolvedValue(issuer);

    await expect(service.getIssuerForPrincipal(ADMIN_PRINCIPAL, ISSUER_ID)).resolves.toBe(issuer);
    expect(grants.existsBy).not.toHaveBeenCalled();
  });
});

describe('AdministrationService mutations', () => {
  it('creates and audits a service account in the same transaction', async () => {
    const harness = createMutationService();

    await expect(
      harness.service.createServiceAccount(ORGANIZATION_ID, 'Orders API', ADMIN_PRINCIPAL),
    ).resolves.toMatchObject({ id: SERVICE_ACCOUNT_ID, organizationId: ORGANIZATION_ID });

    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.serviceAccounts.save).toHaveBeenCalledTimes(1);
    expect(harness.auditLog.save).toHaveBeenCalledTimes(1);
    expect(harness.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'service-account.created',
        organizationId: ORGANIZATION_ID,
        resourceId: SERVICE_ACCOUNT_ID,
      }),
    );
  });

  it('propagates an audit failure so the surrounding transaction can roll back', async () => {
    const harness = createMutationService();
    harness.auditLog.save.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      harness.service.createServiceAccount(ORGANIZATION_ID, 'Orders API', ADMIN_PRINCIPAL),
    ).rejects.toThrow('audit unavailable');

    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.serviceAccounts.save).toHaveBeenCalledTimes(1);
  });

  it('replays API-key creation with the same response and without another credential row', async () => {
    const harness = createMutationService();
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');

    const first = await harness.service.createApiKey(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:write', 'documents:read'],
      expiresAt,
      ADMIN_PRINCIPAL,
      ' create-orders-key ',
    );
    const replay = await harness.service.createApiKey(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read', 'documents:write', 'documents:read'],
      new Date(expiresAt),
      ADMIN_PRINCIPAL,
      'create-orders-key',
    );

    expect(replay).toEqual(first);
    expect(harness.apiKeys.create).toHaveBeenCalledTimes(1);
    expect(harness.apiKeys.create).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read', 'documents:write'],
      expiresAt,
      expect.objectContaining({ manager: harness.manager }),
    );
    expect(harness.apiKeys.restoreIdempotentCreation).toHaveBeenCalledTimes(1);
    expect(harness.auditLog.save).toHaveBeenCalledTimes(1);
    expect(harness.persistedRequest()).toMatchObject({
      organizationId: ORGANIZATION_ID,
      serviceAccountId: SERVICE_ACCOUNT_ID,
      apiKeyId: API_KEY_ID,
      idempotencyKey: 'create-orders-key',
    });
  });

  it('returns a safe conflict when an API-key idempotency key changes meaning', async () => {
    const harness = createMutationService();
    await harness.service.createApiKey(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
      ADMIN_PRINCIPAL,
      'private-request-name',
    );

    const conflict = await harness.service
      .createApiKey(
        ORGANIZATION_ID,
        SERVICE_ACCOUNT_ID,
        ['documents:write'],
        null,
        ADMIN_PRINCIPAL,
        'private-request-name',
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(conflict).toBeInstanceOf(ConflictException);
    const response = JSON.stringify((conflict as ConflictException).getResponse());
    expect(response).not.toContain('private-request-name');
    expect(response).not.toContain('documents:write');
    expect(harness.apiKeys.create).toHaveBeenCalledTimes(1);
  });

  it('resolves a concurrent same-request unique violation from the committed tombstone', async () => {
    const harness = createMutationService();
    const first = await harness.service.createApiKey(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
      ADMIN_PRINCIPAL,
      'concurrent-request',
    );
    harness.transaction.mockRejectedValueOnce({ code: '23505' });

    await expect(
      harness.service.createApiKey(
        ORGANIZATION_ID,
        SERVICE_ACCOUNT_ID,
        ['documents:read'],
        null,
        ADMIN_PRINCIPAL,
        'concurrent-request',
      ),
    ).resolves.toEqual(first);

    expect(harness.apiKeys.create).toHaveBeenCalledTimes(1);
    expect(harness.apiKeys.restoreIdempotentCreation).toHaveBeenCalledTimes(1);
  });

  it('does not mask an unrelated unique violation as an idempotent replay', async () => {
    const harness = createMutationService();
    const violation = { code: '23505', constraint: 'api_keys_prefix_key' };
    harness.transaction.mockRejectedValueOnce(violation);

    await expect(
      harness.service.createApiKey(
        ORGANIZATION_ID,
        SERVICE_ACCOUNT_ID,
        ['documents:read'],
        null,
        ADMIN_PRINCIPAL,
        'new-request',
      ),
    ).rejects.toBe(violation);
    expect(harness.apiKeys.restoreIdempotentCreation).not.toHaveBeenCalled();
  });

  it('returns 409 when a concurrent winner used the key for another request', async () => {
    const harness = createMutationService();
    await harness.service.createApiKey(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
      ADMIN_PRINCIPAL,
      'mixed-concurrent-request',
    );
    harness.transaction.mockRejectedValueOnce({ code: '23505' });

    await expect(
      harness.service.createApiKey(
        ORGANIZATION_ID,
        SERVICE_ACCOUNT_ID,
        ['documents:write'],
        null,
        ADMIN_PRINCIPAL,
        'mixed-concurrent-request',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.apiKeys.create).toHaveBeenCalledTimes(1);
  });

  it('requires a bounded Idempotency-Key before starting API-key creation', async () => {
    const harness = createMutationService();

    await expect(
      harness.service.createApiKey(
        ORGANIZATION_ID,
        SERVICE_ACCOUNT_ID,
        ['documents:read'],
        null,
        ADMIN_PRINCIPAL,
        '   ',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('rejects an API key that would already be expired', async () => {
    const harness = createMutationService();

    await expect(
      harness.service.createApiKey(
        ORGANIZATION_ID,
        SERVICE_ACCOUNT_ID,
        ['documents:read'],
        new Date('2020-01-01T00:00:00.000Z'),
        ADMIN_PRINCIPAL,
        'expired-key-request',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('revokes a credential, clears its encrypted replay, and audits atomically', async () => {
    const harness = createMutationService();

    await harness.service.revokeApiKey(ORGANIZATION_ID, API_KEY_ID, ADMIN_PRINCIPAL);

    expect(harness.apiKeys.revoke).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      API_KEY_ID,
      harness.manager,
    );
    expect(harness.apiKeyReplays.clearForApiKey).toHaveBeenCalledWith(
      harness.manager,
      ORGANIZATION_ID,
      API_KEY_ID,
    );
    expect(harness.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'api-key.revoked', resourceId: API_KEY_ID }),
    );
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a mutation when the actor tenant differs from the target tenant', async () => {
    const harness = createMutationService();

    await expect(
      harness.service.createServiceAccount(ORGANIZATION_ID, 'Orders API', {
        ...ADMIN_PRINCIPAL,
        organizationId: OTHER_ORGANIZATION_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });
});

interface AdministrationServiceHarness {
  readonly service: AdministrationService;
  readonly issuers: jest.Mocked<Pick<Repository<IssuerEntity>, 'findOneBy'>>;
  readonly grants: jest.Mocked<Pick<Repository<ServiceAccountIssuerGrantEntity>, 'existsBy'>>;
}

function createService(): AdministrationServiceHarness {
  const issuers = {
    findOneBy: jest.fn(),
  } as jest.Mocked<Pick<Repository<IssuerEntity>, 'findOneBy'>>;
  const grants = {
    existsBy: jest.fn(),
  } as jest.Mocked<Pick<Repository<ServiceAccountIssuerGrantEntity>, 'existsBy'>>;
  return {
    issuers,
    grants,
    service: new AdministrationService(
      {} as DataSource,
      issuers as unknown as Repository<IssuerEntity>,
      grants as unknown as Repository<ServiceAccountIssuerGrantEntity>,
      {} as ApiKeyService,
      {} as ApiKeyReplayService,
    ),
  };
}

interface MutationServiceHarness {
  readonly apiKeys: {
    readonly create: jest.Mock;
    readonly restoreIdempotentCreation: jest.Mock;
    readonly revoke: jest.Mock;
  };
  readonly apiKeyReplays: {
    readonly clearForApiKey: jest.Mock;
    readonly open: jest.Mock;
    readonly seal: jest.Mock;
  };
  readonly auditLog: RepositoryDouble<AuditLogEntity>;
  readonly manager: EntityManager;
  readonly persistedRequest: () => ApiKeyCreationRequestEntity | null;
  readonly service: AdministrationService;
  readonly serviceAccounts: RepositoryDouble<ServiceAccountEntity>;
  readonly transaction: jest.Mock;
}

interface RepositoryDouble<T extends object> {
  readonly create: jest.Mock<T, [Partial<T>]>;
  readonly findOne: jest.Mock<Promise<T | null>, [unknown]>;
  readonly findOneBy: jest.Mock<Promise<T | null>, [unknown]>;
  readonly save: jest.Mock<Promise<T>, [T]>;
}

function createMutationService(): MutationServiceHarness {
  let persistedRequest: ApiKeyCreationRequestEntity | null = null;
  const requests = repositoryDouble(ApiKeyCreationRequestEntity);
  requests.findOne.mockImplementation(() => Promise.resolve(persistedRequest));
  requests.save.mockImplementation((request) => {
    request.id = '77777777-7777-4777-8777-777777777777';
    persistedRequest = request;
    return Promise.resolve(request);
  });

  const auditLog = repositoryDouble(AuditLogEntity);
  const serviceAccounts = repositoryDouble(ServiceAccountEntity);
  serviceAccounts.save.mockImplementation((account) => {
    account.id = SERVICE_ACCOUNT_ID;
    return Promise.resolve(account);
  });
  const repositoryMap = new Map<unknown, unknown>([
    [ApiKeyCreationRequestEntity, requests],
    [AuditLogEntity, auditLog],
    [ServiceAccountEntity, serviceAccounts],
  ]);
  const manager = {
    getRepository: jest.fn((target: unknown) => {
      const repository = repositoryMap.get(target);
      if (!repository) {
        throw new Error('Unexpected repository requested by test');
      }
      return repository;
    }),
  } as unknown as EntityManager;
  const transaction = jest.fn((first: unknown, second?: unknown): Promise<unknown> => {
    const operation = typeof first === 'function' ? first : second;
    if (typeof operation !== 'function') {
      return Promise.reject(new Error('Transaction callback is required'));
    }
    return Promise.resolve((operation as (value: EntityManager) => unknown)(manager));
  });
  const createdApiKey: CreatedApiKey = {
    id: API_KEY_ID,
    apiKey: `bill_live_${'a'.repeat(16)}.${'B'.repeat(43)}`,
    prefix: 'a'.repeat(16),
    scopes: ['documents:read', 'documents:write'],
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  };
  const apiKeys = {
    create: jest.fn(() => Promise.resolve(createdApiKey)),
    restoreIdempotentCreation: jest.fn(() => Promise.resolve(createdApiKey)),
    revoke: jest.fn(() => Promise.resolve()),
  };
  const apiKeyReplays = {
    seal: jest.fn(() => ({
      credentialEnvelope: {
        version: 1,
        algorithm: 'AES-256-GCM',
        encryptedDataKey: 'encrypted-key',
        dataKeyIv: 'key-iv',
        dataKeyTag: 'key-tag',
        ciphertext: 'ciphertext',
        dataIv: 'data-iv',
        dataTag: 'data-tag',
      },
      replayExpiresAt: new Date('2026-08-22T20:05:00.000Z'),
    })),
    open: jest.fn(() => createdApiKey),
    clearForApiKey: jest.fn(() => Promise.resolve()),
  };
  const issuers = { findOneBy: jest.fn() };
  const grants = { existsBy: jest.fn(), findOneBy: jest.fn() };

  return {
    apiKeys,
    apiKeyReplays,
    auditLog,
    manager,
    persistedRequest: () => persistedRequest,
    service: new AdministrationService(
      { transaction } as unknown as DataSource,
      issuers as unknown as Repository<IssuerEntity>,
      grants as unknown as Repository<ServiceAccountIssuerGrantEntity>,
      apiKeys as unknown as ApiKeyService,
      apiKeyReplays as unknown as ApiKeyReplayService,
    ),
    serviceAccounts,
    transaction,
  };
}

function repositoryDouble<T extends object>(entityType: new () => T): RepositoryDouble<T> {
  return {
    create: jest.fn((values) => Object.assign(new entityType(), values)),
    findOne: jest.fn<Promise<T | null>, [unknown]>().mockResolvedValue(null),
    findOneBy: jest.fn<Promise<T | null>, [unknown]>().mockResolvedValue(null),
    save: jest.fn((entity) => Promise.resolve(entity)),
  };
}

function activeIssuer(): IssuerEntity {
  return Object.assign(new IssuerEntity(), {
    id: ISSUER_ID,
    organizationId: ORGANIZATION_ID,
    ruc: '20131312955',
    legalName: 'ACME SAC',
    tradeName: null,
    address: {},
    active: true,
  });
}
