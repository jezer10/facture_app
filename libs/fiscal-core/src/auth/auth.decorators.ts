import { createParamDecorator, SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ApiKeyScope, AuthenticatedRequest, BillingPrincipal } from './auth.types';

export const PUBLIC_ROUTE = 'billing:public-route';
export const REQUIRED_SCOPES = 'billing:required-scopes';
export const REQUIRED_ADMIN = 'billing:required-admin';
export const REQUIRED_PLATFORM_ADMIN = 'billing:required-platform-admin';

export const PublicRoute = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);
export const RequireScopes = (...scopes: ApiKeyScope[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);
export const RequireAdmin = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ADMIN, true);
export const RequirePlatformAdmin = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PLATFORM_ADMIN, true);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): BillingPrincipal =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().principal,
);
