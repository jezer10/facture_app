import { constantTimeEqual } from '@app/platform';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { SUNAT_INTERNAL_SERVICE_SECRET } from './provisioning.tokens';

@Injectable()
export class InternalServiceAuthGuard implements CanActivate {
  constructor(
    @Inject(SUNAT_INTERNAL_SERVICE_SECRET)
    private readonly expectedSecret: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.header('authorization');
    const provided = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    if (!provided || !constantTimeEqual(provided, this.expectedSecret)) {
      throw new UnauthorizedException('Credencial interna inválida.');
    }
    return true;
  }
}
