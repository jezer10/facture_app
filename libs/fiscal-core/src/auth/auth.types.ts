export const API_KEY_SCOPES = [
  'documents:write',
  'documents:read',
  'received:sync',
  'received:read',
  'issuers:manage',
  'webhooks:manage',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export type OrganizationRole = 'owner' | 'admin' | 'viewer';

export interface MachinePrincipal {
  readonly kind: 'service';
  readonly organizationId: string;
  readonly serviceAccountId: string;
  readonly apiKeyId: string;
  readonly scopes: ReadonlySet<ApiKeyScope>;
}

export interface HumanPrincipal {
  readonly kind: 'human';
  readonly subject: string;
  readonly organizationId?: string;
  readonly role?: OrganizationRole;
  readonly platformAdmin: boolean;
}

export type BillingPrincipal = MachinePrincipal | HumanPrincipal;

export interface AuthenticatedRequest extends Request {
  principal: BillingPrincipal;
  correlationId: string;
}

export interface BillingJwtClaims {
  readonly sub: string;
  readonly organizationId?: string;
  readonly platformAdmin?: boolean;
  readonly iss?: string;
  readonly aud?: string | string[];
}
import type { Request } from 'express';
