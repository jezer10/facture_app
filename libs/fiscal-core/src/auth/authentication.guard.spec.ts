import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { Repository } from 'typeorm';
import { OrganizationMemberEntity } from '../database/entities';
import type { ApiKeyService } from './api-key.service';
import { RequireScopes } from './auth.decorators';
import type { ApiKeyScope, BillingPrincipal, MachinePrincipal } from './auth.types';
import { AuthenticationGuard } from './authentication.guard';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

class ScopedController {
  @RequireScopes('issuers:manage')
  manageIssuer(this: void): void {}
}

describe('AuthenticationGuard scoped administration', () => {
  it('preserves a canonical UUID correlation ID', async () => {
    const correlationId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
    const principal = servicePrincipal(['issuers:manage']);
    const { apiKeys, guard } = createGuard();
    apiKeys.authenticate.mockResolvedValue(principal);
    const { context, request } = createContext('ApiKey credential', correlationId);

    await guard.canActivate(context);

    expect(request.correlationId).toBe(correlationId);
  });

  it.each([
    '------------------------------------',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa',
  ])('replaces a non-UUID correlation value (%s)', async (invalidCorrelationId) => {
    const principal = servicePrincipal(['issuers:manage']);
    const { apiKeys, guard } = createGuard();
    apiKeys.authenticate.mockResolvedValue(principal);
    const { context, request } = createContext('ApiKey credential', invalidCorrelationId);

    await guard.canActivate(context);

    expect(request.correlationId).not.toBe(invalidCorrelationId);
    expect(request.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('allows an API key carrying the required management scope', async () => {
    const principal = servicePrincipal(['issuers:manage']);
    const { apiKeys, guard } = createGuard();
    apiKeys.authenticate.mockResolvedValue(principal);
    const { context, request } = createContext('ApiKey credential');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.principal).toBe(principal);
  });

  it('denies an API key without the required management scope', async () => {
    const { apiKeys, guard } = createGuard();
    apiKeys.authenticate.mockResolvedValue(servicePrincipal(['documents:read']));
    const { context } = createContext('ApiKey credential');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies a human viewer for management scopes', async () => {
    const { guard, jwt, members } = createGuard();
    jwt.verifyAsync.mockResolvedValue({ sub: 'viewer', organizationId: ORGANIZATION_ID });
    members.findOneBy.mockResolvedValue(
      Object.assign(new OrganizationMemberEntity(), {
        organizationId: ORGANIZATION_ID,
        subject: 'viewer',
        role: 'viewer',
      }),
    );
    const { context } = createContext('Bearer token');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a human organization administrator for management scopes', async () => {
    const { guard, jwt, members } = createGuard();
    jwt.verifyAsync.mockResolvedValue({ sub: 'admin', organizationId: ORGANIZATION_ID });
    members.findOneBy.mockResolvedValue(
      Object.assign(new OrganizationMemberEntity(), {
        organizationId: ORGANIZATION_ID,
        subject: 'admin',
        role: 'admin',
      }),
    );
    const { context } = createContext('Bearer token');

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

interface GuardHarness {
  readonly guard: AuthenticationGuard;
  readonly apiKeys: jest.Mocked<Pick<ApiKeyService, 'authenticate'>>;
  readonly jwt: jest.Mocked<Pick<JwtService, 'verifyAsync'>>;
  readonly members: jest.Mocked<Pick<Repository<OrganizationMemberEntity>, 'findOneBy'>>;
}

function createGuard(): GuardHarness {
  const apiKeys = {
    authenticate: jest.fn(),
  } as jest.Mocked<Pick<ApiKeyService, 'authenticate'>>;
  const jwt = {
    verifyAsync: jest.fn(),
  } as unknown as jest.Mocked<Pick<JwtService, 'verifyAsync'>>;
  const members = {
    findOneBy: jest.fn(),
  } as jest.Mocked<Pick<Repository<OrganizationMemberEntity>, 'findOneBy'>>;

  return {
    apiKeys,
    jwt,
    members,
    guard: new AuthenticationGuard(
      new Reflector(),
      apiKeys as unknown as ApiKeyService,
      jwt as unknown as JwtService,
      members as unknown as Repository<OrganizationMemberEntity>,
    ),
  };
}

interface RequestDouble {
  readonly get: (name: string) => string | undefined;
  principal?: BillingPrincipal;
  correlationId?: string;
}

function createContext(
  authorization: string,
  correlationId?: string,
): {
  readonly context: ExecutionContext;
  readonly request: RequestDouble;
} {
  const request: RequestDouble = {
    get: (name) => {
      if (name === 'authorization') return authorization;
      if (name === 'x-correlation-id') return correlationId;
      return undefined;
    },
  };
  const context = {
    getClass: () => ScopedController,
    getHandler: () => ScopedController.prototype.manageIssuer,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function servicePrincipal(scopes: readonly ApiKeyScope[]): MachinePrincipal {
  return {
    kind: 'service',
    organizationId: ORGANIZATION_ID,
    serviceAccountId: '22222222-2222-4222-8222-222222222222',
    apiKeyId: '33333333-3333-4333-8333-333333333333',
    scopes: new Set(scopes),
  };
}
