import { GoneException, Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager, Repository } from 'typeorm';
import { canonicalJson, EnvelopeEncryption, type EncryptedEnvelope } from '@app/platform';
import type { CreatedApiKey } from '../auth/api-key.service';
import type { ApiKeyScope } from '../auth/auth.types';
import { API_KEY_SCOPES } from '../auth/auth.types';
import { ApiKeyCreationRequestEntity } from '../database/entities';

export const API_KEY_REPLAY_ENCRYPTION = Symbol('API_KEY_REPLAY_ENCRYPTION');
export const API_KEY_REPLAY_TTL_SECONDS = Symbol('API_KEY_REPLAY_TTL_SECONDS');

export interface ApiKeyReplayIdentity {
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly requestSha256: string;
  readonly serviceAccountId: string;
}

export interface SealedApiKeyReplay {
  readonly credentialEnvelope: EncryptedEnvelope;
  readonly replayExpiresAt: Date;
}

@Injectable()
export class ApiKeyReplayService {
  constructor(
    @InjectRepository(ApiKeyCreationRequestEntity)
    private readonly requests: Repository<ApiKeyCreationRequestEntity>,
    @Inject(API_KEY_REPLAY_ENCRYPTION)
    private readonly encryption: EnvelopeEncryption,
    @Inject(API_KEY_REPLAY_TTL_SECONDS)
    private readonly ttlSeconds: number,
  ) {}

  seal(
    credential: CreatedApiKey,
    identity: ApiKeyReplayIdentity,
    now: Date = new Date(),
  ): SealedApiKeyReplay {
    const replayExpiresAt = new Date(now.getTime() + this.ttlSeconds * 1_000);
    const plaintext = Buffer.from(
      canonicalJson({
        apiKey: credential.apiKey,
        expiresAt: credential.expiresAt?.toISOString() ?? null,
        id: credential.id,
        prefix: credential.prefix,
        replayExpiresAt: replayExpiresAt.toISOString(),
        scopes: [...credential.scopes],
      }),
      'utf8',
    );
    try {
      return {
        credentialEnvelope: this.encryption.encrypt(
          plaintext,
          replayContext(identity, replayExpiresAt),
        ),
        replayExpiresAt,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  open(request: ApiKeyCreationRequestEntity, now: Date = new Date()): CreatedApiKey {
    if (!request.credentialEnvelope || request.replayExpiresAt.getTime() <= now.getTime()) {
      throw replayUnavailable();
    }
    const plaintext = this.encryption.decrypt(
      request.credentialEnvelope,
      replayContext(
        {
          apiKeyId: request.apiKeyId,
          organizationId: request.organizationId,
          requestSha256: request.requestSha256,
          serviceAccountId: request.serviceAccountId,
        },
        request.replayExpiresAt,
      ),
    );
    try {
      const replay = parseApiKeyReplay(JSON.parse(plaintext.toString('utf8')) as unknown);
      if (
        replay.replayExpiresAt.getTime() !== request.replayExpiresAt.getTime() ||
        replay.replayExpiresAt.getTime() <= now.getTime()
      ) {
        throw replayUnavailable();
      }
      return replay.credential;
    } finally {
      plaintext.fill(0);
    }
  }

  async clearForApiKey(
    manager: EntityManager,
    organizationId: string,
    apiKeyId: string,
  ): Promise<void> {
    await manager
      .getRepository(ApiKeyCreationRequestEntity)
      .update({ organizationId, apiKeyId }, { credentialEnvelope: null });
  }

  @Interval(60_000)
  async purgeExpired(): Promise<void> {
    await this.requests
      .createQueryBuilder()
      .update(ApiKeyCreationRequestEntity)
      .set({ credentialEnvelope: null })
      .where('credential_envelope IS NOT NULL')
      .andWhere('replay_expires_at <= :now', { now: new Date() })
      .execute();
  }
}

function replayContext(identity: ApiKeyReplayIdentity, replayExpiresAt: Date): string {
  return [
    'billing-api-key-replay:v1',
    identity.organizationId,
    identity.serviceAccountId,
    identity.apiKeyId,
    identity.requestSha256,
    replayExpiresAt.toISOString(),
  ].join(':');
}

function parseApiKeyReplay(value: unknown): {
  readonly credential: CreatedApiKey;
  readonly replayExpiresAt: Date;
} {
  if (!isRecord(value)) {
    throw new Error('Encrypted API-key replay payload is not an object');
  }
  const { apiKey, expiresAt, id, prefix, replayExpiresAt, scopes } = value;
  if (
    typeof id !== 'string' ||
    typeof apiKey !== 'string' ||
    typeof prefix !== 'string' ||
    typeof replayExpiresAt !== 'string' ||
    !Array.isArray(scopes) ||
    scopes.some((scope) => typeof scope !== 'string' || !KNOWN_SCOPES.has(scope)) ||
    (expiresAt !== null && typeof expiresAt !== 'string')
  ) {
    throw new Error('Encrypted API-key replay payload is malformed');
  }
  const parsedExpiration = expiresAt === null ? null : new Date(expiresAt);
  const parsedReplayExpiration = new Date(replayExpiresAt);
  if (
    (parsedExpiration && !Number.isFinite(parsedExpiration.getTime())) ||
    !Number.isFinite(parsedReplayExpiration.getTime())
  ) {
    throw new Error('Encrypted API-key replay expiration is malformed');
  }
  return {
    credential: {
      id,
      apiKey,
      prefix,
      scopes: scopes as ApiKeyScope[],
      expiresAt: parsedExpiration,
    },
    replayExpiresAt: parsedReplayExpiration,
  };
}

function replayUnavailable(): GoneException {
  return new GoneException({
    statusCode: 410,
    code: 'API_KEY_REPLAY_UNAVAILABLE',
    message: 'The API-key creation response is no longer available for replay',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KNOWN_SCOPES: ReadonlySet<string> = new Set(API_KEY_SCOPES);
