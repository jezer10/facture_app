import type { ExecutionContext } from '@nestjs/common';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { InternalWebhookAuthGuard } from './internal-webhook-auth.guard';

describe('InternalWebhookAuthGuard', () => {
  it('accepts an exact bearer token', () => {
    const guard = new InternalWebhookAuthGuard({ bearerToken: 'token_123' });

    expect(guard.canActivate(createContext('Bearer token_123'))).toBe(true);
  });

  it('fails closed when authentication is not configured', () => {
    const guard = new InternalWebhookAuthGuard({});

    expect(() => guard.canActivate(createContext())).toThrow(ServiceUnavailableException);
  });

  it('rejects an invalid credential without exposing the expected token', () => {
    const guard = new InternalWebhookAuthGuard({ bearerToken: 'token_123' });

    expect(() => guard.canActivate(createContext('Bearer invalid'))).toThrow(UnauthorizedException);
  });
});

function createContext(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}
