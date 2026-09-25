import { GoneException } from '@nestjs/common';
import type { EntityManager, Repository } from 'typeorm';
import { EnvelopeEncryption } from '@app/platform';
import type { CreatedApiKey } from '../auth/api-key.service';
import { ApiKeyCreationRequestEntity } from '../database/entities';
import { ApiKeyReplayService } from './api-key-replay.service';
import type { ApiKeyReplayIdentity } from './api-key-replay.service';

const CREDENTIAL: CreatedApiKey = {
  id: '11111111-1111-4111-8111-111111111111',
  apiKey: `bill_live_${'a'.repeat(16)}.${'B'.repeat(43)}`,
  prefix: 'a'.repeat(16),
  scopes: ['documents:read'],
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
};

describe('ApiKeyReplayService', () => {
  it('stores only an encrypted, time-bounded replay and restores it with bound context', () => {
    const service = createService();
    const now = new Date('2026-08-22T20:00:00.000Z');
    const identity = replayIdentity();
    const sealed = service.seal(CREDENTIAL, identity, now);
    const request = requestEntity(sealed);

    expect(JSON.stringify(sealed.credentialEnvelope)).not.toContain(CREDENTIAL.apiKey);
    expect(sealed.replayExpiresAt.toISOString()).toBe('2026-08-22T20:05:00.000Z');
    expect(service.open(request, new Date('2026-08-22T20:04:59.000Z'))).toEqual(CREDENTIAL);
    request.organizationId = '22222222-2222-4222-8222-222222222222';
    expect(() => service.open(request, now)).toThrow();
  });

  it('authenticates the replay deadline so a database edit cannot extend it', () => {
    const service = createService();
    const now = new Date('2026-08-22T20:00:00.000Z');
    const request = requestEntity(service.seal(CREDENTIAL, replayIdentity(), now));
    request.replayExpiresAt = new Date('2026-08-22T21:05:00.000Z');

    expect(() => service.open(request, new Date('2026-08-22T20:06:00.000Z'))).toThrow();
  });

  it('returns 410 without decrypting after the replay window', () => {
    const service = createService();
    const now = new Date('2026-08-22T20:00:00.000Z');
    const request = requestEntity(service.seal(CREDENTIAL, replayIdentity(), now));

    expect(() => service.open(request, new Date('2026-08-22T20:05:00.000Z'))).toThrow(
      GoneException,
    );
  });

  it('clears cached credential material when its API key is revoked', async () => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const manager = { getRepository: jest.fn(() => ({ update })) } as unknown as EntityManager;
    const service = createService();

    await service.clearForApiKey(
      manager,
      replayIdentity().organizationId,
      replayIdentity().apiKeyId,
    );

    expect(update).toHaveBeenCalledWith(
      {
        organizationId: replayIdentity().organizationId,
        apiKeyId: replayIdentity().apiKeyId,
      },
      { credentialEnvelope: null },
    );
  });

  it('purges expired encrypted responses while retaining their tombstones', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 2 });
    const andWhere = jest
      .fn<{ execute: typeof execute }, [string, { now: Date }]>()
      .mockReturnValue({ execute });
    const where = jest.fn(() => ({ andWhere }));
    const set = jest.fn(() => ({ where }));
    const update = jest.fn(() => ({ set }));
    const repository = {
      createQueryBuilder: jest.fn(() => ({ update })),
    } as unknown as Repository<ApiKeyCreationRequestEntity>;
    const service = new ApiKeyReplayService(
      repository,
      new EnvelopeEncryption(Buffer.alloc(32, 9)),
      300,
    );

    await service.purgeExpired();

    expect(set).toHaveBeenCalledWith({ credentialEnvelope: null });
    expect(where).toHaveBeenCalledWith('credential_envelope IS NOT NULL');
    const [condition, parameters] = andWhere.mock.calls[0] ?? [];
    expect(condition).toBe('replay_expires_at <= :now');
    expect(
      typeof parameters === 'object' &&
        parameters !== null &&
        'now' in parameters &&
        parameters.now instanceof Date,
    ).toBe(true);
  });
});

function createService(): ApiKeyReplayService {
  return new ApiKeyReplayService(
    {} as Repository<ApiKeyCreationRequestEntity>,
    new EnvelopeEncryption(Buffer.alloc(32, 9)),
    300,
  );
}

function replayIdentity(): ApiKeyReplayIdentity {
  return {
    apiKeyId: CREDENTIAL.id,
    organizationId: '33333333-3333-4333-8333-333333333333',
    requestSha256: 'c'.repeat(64),
    serviceAccountId: '44444444-4444-4444-8444-444444444444',
  };
}

function requestEntity(
  sealed: ReturnType<ApiKeyReplayService['seal']>,
): ApiKeyCreationRequestEntity {
  return Object.assign(new ApiKeyCreationRequestEntity(), replayIdentity(), sealed, {
    id: '55555555-5555-4555-8555-555555555555',
    idempotencyKey: 'request-1',
  });
}
