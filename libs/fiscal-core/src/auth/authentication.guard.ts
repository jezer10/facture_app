import { randomUUID } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { OrganizationMemberEntity } from '../database/entities';
import { ApiKeyService } from './api-key.service';
import {
  PUBLIC_ROUTE,
  REQUIRED_ADMIN,
  REQUIRED_PLATFORM_ADMIN,
  REQUIRED_SCOPES,
} from './auth.decorators';
import type {
  ApiKeyScope,
  AuthenticatedRequest,
  BillingJwtClaims,
  BillingPrincipal,
  HumanPrincipal,
} from './auth.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
    private readonly jwt: JwtService,
    @InjectRepository(OrganizationMemberEntity)
    private readonly members: Repository<OrganizationMemberEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.correlationId = readCorrelationId(request);
    const authorization = request.get('authorization');
    if (!authorization) {
      throw new UnauthorizedException('Authorization header is required');
    }

    const principal = authorization.startsWith('ApiKey ')
      ? await this.apiKeys.authenticate(authorization)
      : await this.authenticateHuman(authorization);
    request.principal = principal;
    this.authorizeRoute(context, principal);
    return true;
  }

  private async authenticateHuman(authorization: string): Promise<HumanPrincipal> {
    const token = /^Bearer (\S+)$/u.exec(authorization)?.[1];
    if (!token) {
      throw new UnauthorizedException('Unsupported authorization scheme');
    }

    let claims: BillingJwtClaims;
    try {
      claims = await this.jwt.verifyAsync<BillingJwtClaims>(token);
    } catch {
      throw new UnauthorizedException('Invalid bearer token');
    }
    if (!claims.sub) {
      throw new UnauthorizedException('Bearer token is missing its subject');
    }
    if (claims.platformAdmin === true) {
      return { kind: 'human', subject: claims.sub, platformAdmin: true };
    }
    if (!claims.organizationId) {
      throw new UnauthorizedException('Bearer token is missing its organization');
    }

    const membership = await this.members.findOneBy({
      organizationId: claims.organizationId,
      subject: claims.sub,
    });
    if (!membership) {
      throw new UnauthorizedException('Organization membership is inactive');
    }
    return {
      kind: 'human',
      subject: claims.sub,
      organizationId: membership.organizationId,
      role: membership.role,
      platformAdmin: false,
    };
  }

  private authorizeRoute(context: ExecutionContext, principal: BillingPrincipal): void {
    const platformAdmin = this.reflector.getAllAndOverride<boolean>(REQUIRED_PLATFORM_ADMIN, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (platformAdmin && (principal.kind !== 'human' || !principal.platformAdmin)) {
      throw new ForbiddenException('Platform administrator access is required');
    }

    const admin = this.reflector.getAllAndOverride<boolean>(REQUIRED_ADMIN, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (
      admin &&
      (principal.kind !== 'human' ||
        principal.platformAdmin ||
        (principal.role !== 'owner' && principal.role !== 'admin'))
    ) {
      throw new ForbiddenException('Organization administrator access is required');
    }

    const scopes = this.reflector.getAllAndOverride<readonly ApiKeyScope[]>(REQUIRED_SCOPES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (principal.kind === 'service' && scopes?.some((scope) => !principal.scopes.has(scope))) {
      throw new ForbiddenException('API key does not have the required scope');
    }
    const humanWriteScopes: ReadonlySet<ApiKeyScope> = new Set([
      'documents:write',
      'received:sync',
      'issuers:manage',
      'webhooks:manage',
    ]);
    if (
      principal.kind === 'human' &&
      scopes?.some((scope) => humanWriteScopes.has(scope)) &&
      principal.role !== 'owner' &&
      principal.role !== 'admin'
    ) {
      throw new ForbiddenException('Organization administrator access is required');
    }
  }
}

function readCorrelationId(request: Request): string {
  const candidate = request.get('x-correlation-id');
  return candidate && UUID_PATTERN.test(candidate) ? candidate : randomUUID();
}
