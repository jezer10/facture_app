import { constantTimeEqual } from '@app/platform';
import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  INTERNAL_WEBHOOK_API_CREDENTIAL,
  type InternalWebhookApiCredential,
} from './webhook-service.tokens';

@Injectable()
export class InternalWebhookAuthGuard implements CanActivate {
  constructor(
    @Inject(INTERNAL_WEBHOOK_API_CREDENTIAL)
    private readonly credential: InternalWebhookApiCredential,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.credential.bearerToken;
    if (expected === undefined) {
      throw new ServiceUnavailableException(
        'Internal webhook API authentication is not configured',
      );
    }

    const authorization = context.switchToHttp().getRequest<Request>().headers.authorization;
    const presented = extractBearerToken(authorization);

    if (
      presented === undefined ||
      presented.length > 2_048 ||
      !constantTimeEqual(presented, expected)
    ) {
      throw new UnauthorizedException('Invalid internal API credential');
    }

    return true;
  }
}

function extractBearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(header ?? '');
  return match?.[1];
}
