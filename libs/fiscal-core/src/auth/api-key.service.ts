import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { ApiKeyEntity, ServiceAccountEntity } from '../database/entities';
import type { ApiKeyScope, MachinePrincipal } from './auth.types';
import { API_KEY_SCOPES } from './auth.types';

export const API_KEY_PEPPER = Symbol('API_KEY_PEPPER');

export interface CreatedApiKey {
  readonly id: string;
  readonly apiKey: string;
  readonly prefix: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly expiresAt: Date | null;
}

export interface CreateApiKeyOptions {
  readonly manager?: EntityManager;
}

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(ApiKeyEntity)
    private readonly apiKeys: Repository<ApiKeyEntity>,
    @InjectRepository(ServiceAccountEntity)
    private readonly serviceAccounts: Repository<ServiceAccountEntity>,
    @Inject(API_KEY_PEPPER) private readonly pepper: Buffer,
  ) {
    if (pepper.length < 32) {
      throw new Error('API key pepper must contain at least 32 bytes');
    }
  }

  async create(
    organizationId: string,
    serviceAccountId: string,
    scopes: readonly ApiKeyScope[],
    expiresAt: Date | null,
    options: CreateApiKeyOptions = {},
  ): Promise<CreatedApiKey> {
    assertKnownScopes(scopes);
    const serviceAccounts =
      options.manager?.getRepository(ServiceAccountEntity) ?? this.serviceAccounts;
    const apiKeys = options.manager?.getRepository(ApiKeyEntity) ?? this.apiKeys;
    const account = await serviceAccounts.findOneBy({
      id: serviceAccountId,
      organizationId,
      active: true,
    });
    if (!account) {
      throw new NotFoundException('Active service account was not found in this organization');
    }

    const { prefix, secret } = createCredential();
    const apiKey = `bill_live_${prefix}.${secret}`;
    const entity = apiKeys.create({
      organizationId,
      serviceAccountId,
      prefix,
      digest: this.digest(prefix, secret),
      scopes: [...new Set(scopes)].sort(),
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    });
    const saved = await apiKeys.save(entity);

    return {
      id: saved.id,
      apiKey,
      prefix,
      scopes: saved.scopes as ApiKeyScope[],
      expiresAt: saved.expiresAt,
    };
  }

  async restoreIdempotentCreation(
    manager: EntityManager,
    organizationId: string,
    serviceAccountId: string,
    apiKeyId: string,
    credential: CreatedApiKey,
  ): Promise<CreatedApiKey> {
    const stored = await manager.getRepository(ApiKeyEntity).findOneBy({
      id: apiKeyId,
      organizationId,
      serviceAccountId,
    });
    if (!stored) {
      throw new Error('Idempotent API key creation references a missing credential');
    }
    if (stored.revokedAt || (stored.expiresAt && stored.expiresAt.getTime() <= Date.now())) {
      throw new GoneException({
        statusCode: 410,
        code: 'API_KEY_REPLAY_UNAVAILABLE',
        message: 'The API-key creation response is no longer available for replay',
      });
    }
    const account = await manager.getRepository(ServiceAccountEntity).findOneBy({
      id: serviceAccountId,
      organizationId,
      active: true,
    });
    if (!account) {
      throw new GoneException({
        statusCode: 410,
        code: 'API_KEY_REPLAY_UNAVAILABLE',
        message: 'The API-key creation response is no longer available for replay',
      });
    }

    const parsed = parseRawApiKey(credential.apiKey);
    if (
      credential.id !== stored.id ||
      credential.prefix !== parsed.prefix ||
      stored.prefix !== parsed.prefix ||
      !safeDigestEqual(stored.digest, this.digest(parsed.prefix, parsed.secret)) ||
      !sameScopes(stored.scopes, credential.scopes) ||
      !sameExpiration(stored.expiresAt, credential.expiresAt)
    ) {
      throw new Error('Idempotent API key credential material does not match persisted state');
    }
    return credential;
  }

  async authenticate(rawAuthorization: string): Promise<MachinePrincipal> {
    const parsed = parseApiKeyAuthorization(rawAuthorization);
    const key = await this.apiKeys.findOne({
      where: { prefix: parsed.prefix, revokedAt: IsNull() },
    });
    if (!key || !safeDigestEqual(key.digest, this.digest(parsed.prefix, parsed.secret))) {
      throw new UnauthorizedException('Invalid API key');
    }
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('API key has expired');
    }

    const account = await this.serviceAccounts.findOneBy({
      id: key.serviceAccountId,
      organizationId: key.organizationId,
      active: true,
    });
    if (!account) {
      throw new UnauthorizedException('Service account is inactive');
    }

    const scopes = key.scopes as ApiKeyScope[];
    assertKnownScopes(scopes);
    await this.apiKeys.update(key.id, { lastUsedAt: new Date() });
    return {
      kind: 'service',
      organizationId: key.organizationId,
      serviceAccountId: key.serviceAccountId,
      apiKeyId: key.id,
      scopes: new Set(scopes),
    };
  }

  async revoke(organizationId: string, apiKeyId: string, manager?: EntityManager): Promise<void> {
    const apiKeys = manager?.getRepository(ApiKeyEntity) ?? this.apiKeys;
    const result = await apiKeys.update(
      { id: apiKeyId, organizationId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    if (result.affected !== 1) {
      throw new NotFoundException('Active API key was not found in this organization');
    }
  }

  private digest(prefix: string, secret: string): string {
    return createHmac('sha256', this.pepper).update(`${prefix}.${secret}`).digest('hex');
  }
}

function parseApiKeyAuthorization(value: string): { prefix: string; secret: string } {
  if (!value.startsWith('ApiKey ')) {
    throw new UnauthorizedException('Invalid API key');
  }
  return parseRawApiKey(value.slice('ApiKey '.length));
}

function parseRawApiKey(value: string): { prefix: string; secret: string } {
  const match = /^bill_live_([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/u.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new UnauthorizedException('Invalid API key');
  }
  return { prefix: match[1], secret: match[2] };
}

function safeDigestEqual(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function assertKnownScopes(scopes: readonly string[]): asserts scopes is readonly ApiKeyScope[] {
  const allowed: ReadonlySet<string> = new Set(API_KEY_SCOPES);
  if (scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
    throw new Error('At least one valid API key scope is required');
  }
}

function createCredential(): { readonly prefix: string; readonly secret: string } {
  return {
    prefix: randomBytes(8).toString('hex'),
    secret: randomBytes(32).toString('base64url'),
  };
}

function sameScopes(stored: readonly string[], replayed: readonly string[]): boolean {
  return JSON.stringify([...stored].sort()) === JSON.stringify([...replayed].sort());
}

function sameExpiration(stored: Date | null, replayed: Date | null): boolean {
  return stored?.getTime() === replayed?.getTime();
}
