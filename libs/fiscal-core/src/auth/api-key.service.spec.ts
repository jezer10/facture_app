import { GoneException, UnauthorizedException } from '@nestjs/common';
import type { EntityManager, Repository } from 'typeorm';
import { ApiKeyEntity, ServiceAccountEntity } from '../database/entities';
import { ApiKeyService } from './api-key.service';

interface ApiKeyRepositoryDouble {
  readonly create: jest.Mock<ApiKeyEntity, [Partial<ApiKeyEntity>]>;
  readonly findOne: jest.Mock<Promise<ApiKeyEntity | null>, [unknown]>;
  readonly findOneBy: jest.Mock<Promise<ApiKeyEntity | null>, [unknown]>;
  readonly save: jest.Mock<Promise<ApiKeyEntity>, [ApiKeyEntity]>;
  readonly update: jest.Mock<Promise<{ affected: number }>, [unknown, unknown]>;
}

interface ServiceAccountRepositoryDouble {
  readonly findOneBy: jest.Mock<Promise<ServiceAccountEntity | null>, [unknown]>;
}

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

describe('ApiKeyService', () => {
  it('returns the raw key once while persisting only an HMAC digest', async () => {
    const harness = createHarness();

    const created = await harness.service.create(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:write', 'documents:read'],
      null,
    );

    expect(created.apiKey).toMatch(/^bill_live_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/u);
    expect(harness.storedKey.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.storedKey.digest).not.toContain(created.apiKey);
    expect(harness.storedKey).not.toHaveProperty('secret');
    expect(harness.storedKey.scopes).toEqual(['documents:read', 'documents:write']);
  });

  it('validates an encrypted idempotent replay against the stored digest', async () => {
    const harness = createHarness();

    const created = await harness.service.create(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
    );
    harness.apiKeys.findOneBy.mockResolvedValue(harness.storedKey);
    const manager = entityManager(harness);

    const restored = await harness.service.restoreIdempotentCreation(
      manager,
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      harness.storedKey.id,
      created,
    );

    expect(restored).toEqual(created);
    expect(harness.storedKey).not.toHaveProperty('secret');
  });

  it('does not replay the secret of a revoked credential', async () => {
    const harness = createHarness();
    const created = await harness.service.create(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
    );
    harness.storedKey.revokedAt = new Date();
    harness.apiKeys.findOneBy.mockResolvedValue(harness.storedKey);
    const manager = entityManager(harness);

    await expect(
      harness.service.restoreIdempotentCreation(
        manager,
        ORGANIZATION_ID,
        SERVICE_ACCOUNT_ID,
        harness.storedKey.id,
        created,
      ),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('does not replay a secret after its service account is deactivated', async () => {
    const harness = createHarness();
    const created = await harness.service.create(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
    );
    harness.apiKeys.findOneBy.mockResolvedValue(harness.storedKey);
    harness.serviceAccounts.findOneBy.mockResolvedValue(null);

    await expect(
      harness.service.restoreIdempotentCreation(
        entityManager(harness),
        ORGANIZATION_ID,
        SERVICE_ACCOUNT_ID,
        harness.storedKey.id,
        created,
      ),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('uses independent random material for each newly created key', async () => {
    const harness = createHarness();

    const first = await harness.service.create(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
    );
    const second = await harness.service.create(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
    );

    expect(second.apiKey).not.toBe(first.apiKey);
  });

  it('authenticates an active key and derives its tenant from storage', async () => {
    const harness = createHarness();
    const created = await harness.service.create(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:write'],
      null,
    );
    harness.apiKeys.findOne.mockResolvedValue(harness.storedKey);

    const principal = await harness.service.authenticate(`ApiKey ${created.apiKey}`);

    expect(principal).toMatchObject({
      kind: 'service',
      organizationId: ORGANIZATION_ID,
      serviceAccountId: SERVICE_ACCOUNT_ID,
      apiKeyId: harness.storedKey.id,
    });
    expect(principal.scopes.has('documents:write')).toBe(true);
    const updateCall = harness.apiKeys.update.mock.calls[0];
    expect(updateCall?.[0]).toBe(harness.storedKey.id);
    expect(isRecord(updateCall?.[1]) && updateCall[1].lastUsedAt instanceof Date).toBe(true);
  });

  it('rejects a key with the right prefix but a different secret', async () => {
    const harness = createHarness();
    const created = await harness.service.create(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
    );
    harness.apiKeys.findOne.mockResolvedValue(harness.storedKey);
    const prefix = created.apiKey.split('.')[0];
    const attackerKey = `${prefix}.${'A'.repeat(43)}`;

    await expect(harness.service.authenticate(`ApiKey ${attackerKey}`)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects expired keys before resolving the service account', async () => {
    const harness = createHarness();
    const created = await harness.service.create(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      new Date(Date.now() - 1_000),
    );
    harness.apiKeys.findOne.mockResolvedValue(harness.storedKey);
    harness.serviceAccounts.findOneBy.mockClear();

    await expect(harness.service.authenticate(`ApiKey ${created.apiKey}`)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(harness.serviceAccounts.findOneBy).not.toHaveBeenCalled();
  });
});

function createHarness(): {
  readonly service: ApiKeyService;
  readonly apiKeys: ApiKeyRepositoryDouble;
  readonly serviceAccounts: ServiceAccountRepositoryDouble;
  readonly storedKey: ApiKeyEntity;
} {
  const storedKey = new ApiKeyEntity();
  const apiKeys: ApiKeyRepositoryDouble = {
    create: jest.fn((values) => Object.assign(new ApiKeyEntity(), values)),
    findOne: jest.fn<Promise<ApiKeyEntity | null>, [unknown]>(() => Promise.resolve(null)),
    findOneBy: jest.fn<Promise<ApiKeyEntity | null>, [unknown]>(() => Promise.resolve(null)),
    save: jest.fn((entity) => {
      entity.id = '33333333-3333-4333-8333-333333333333';
      Object.assign(storedKey, entity);
      return Promise.resolve(entity);
    }),
    update: jest.fn<Promise<{ affected: number }>, [unknown, unknown]>(() =>
      Promise.resolve({ affected: 1 }),
    ),
  };
  const activeAccount = Object.assign(new ServiceAccountEntity(), {
    id: SERVICE_ACCOUNT_ID,
    organizationId: ORGANIZATION_ID,
    active: true,
    name: 'Orders API',
  });
  const serviceAccounts: ServiceAccountRepositoryDouble = {
    findOneBy: jest.fn<Promise<ServiceAccountEntity | null>, [unknown]>(() =>
      Promise.resolve(activeAccount),
    ),
  };

  return {
    apiKeys,
    serviceAccounts,
    storedKey,
    service: new ApiKeyService(
      apiKeys as unknown as Repository<ApiKeyEntity>,
      serviceAccounts as unknown as Repository<ServiceAccountEntity>,
      Buffer.alloc(32, 7),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function entityManager(harness: {
  readonly apiKeys: ApiKeyRepositoryDouble;
  readonly serviceAccounts: ServiceAccountRepositoryDouble;
}): EntityManager {
  return {
    getRepository: jest.fn((target: unknown) =>
      target === ApiKeyEntity ? harness.apiKeys : harness.serviceAccounts,
    ),
  } as unknown as EntityManager;
}
