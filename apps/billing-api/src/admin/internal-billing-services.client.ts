import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { constantTimeEqual, parseEnvironment, readSecretFile } from '@app/platform';
import { z } from 'zod';
import type { ProvisionSunatCredentialDto } from './admin.dto';

const sunatCredentialStatusSchema = z.object({
  issuerId: z.uuid(),
  issuerRuc: z.string().regex(/^\d{11}$/u),
  environment: z.enum(['beta', 'production']),
  version: z.number().int().positive(),
  active: z.boolean(),
  hasCertificate: z.boolean(),
  certificateArchiveSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  certificateExpiresAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

const sunatCredentialConfigurationSchema = z.union([
  z.object({ configured: z.literal(false), issuerId: z.uuid() }),
  sunatCredentialStatusSchema.extend({ configured: z.literal(true) }),
]);

const webhookSubscriptionSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  endpointUrl: z.url(),
  eventTypes: z.array(z.string()),
  status: z.enum(['active', 'disabled']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export interface SunatCredentialStatus {
  readonly issuerId: string;
  readonly issuerRuc: string;
  readonly environment: 'beta' | 'production';
  readonly version: number;
  readonly active: boolean;
  readonly hasCertificate: boolean;
  readonly certificateArchiveSha256: string | null;
  readonly certificateExpiresAt: string | null;
  readonly updatedAt: string;
}

export type SunatCredentialConfiguration =
  | { readonly configured: false; readonly issuerId: string }
  | ({ readonly configured: true } & SunatCredentialStatus);

export interface WebhookSubscriptionView {
  readonly id: string;
  readonly organizationId: string;
  readonly endpointUrl: string;
  readonly eventTypes: readonly string[];
  readonly status: 'active' | 'disabled';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConfigureWebhookSubscription {
  readonly endpointUrl: string;
  readonly eventTypes: readonly string[];
  readonly enabled: boolean;
  readonly secret?: string;
}

@Injectable()
export class InternalBillingServicesClient {
  private readonly environment = parseEnvironment(process.env);
  private readonly sunatBearerToken = this.loadBearerToken(
    this.environment.SUNAT_INTERNAL_SERVICE_SECRET_FILE,
  );
  private readonly webhookBearerToken = this.loadBearerToken(
    this.environment.WEBHOOK_INTERNAL_SERVICE_SECRET_FILE,
  );

  constructor() {
    if (
      this.sunatBearerToken &&
      this.webhookBearerToken &&
      constantTimeEqual(this.sunatBearerToken, this.webhookBearerToken)
    ) {
      throw new Error('SUNAT and webhook internal service secrets must contain different values');
    }
  }

  provisionSunatCredential(
    organizationId: string,
    issuerId: string,
    issuerRuc: string,
    input: ProvisionSunatCredentialDto,
  ): Promise<SunatCredentialStatus> {
    return this.request<SunatCredentialStatus>(
      this.environment.SUNAT_INTERNAL_URL,
      `/internal/issuers/${encodeURIComponent(issuerId)}/sunat-credentials`,
      {
        method: 'PUT',
        body: JSON.stringify({ organizationId, issuerRuc, ...input }),
      },
      sunatCredentialStatusSchema,
      this.sunatBearerToken,
    );
  }

  getSunatCredential(issuerId: string): Promise<SunatCredentialConfiguration> {
    return this.request<SunatCredentialConfiguration>(
      this.environment.SUNAT_INTERNAL_URL,
      `/internal/issuers/${encodeURIComponent(issuerId)}/sunat-credentials`,
      { method: 'GET' },
      sunatCredentialConfigurationSchema,
      this.sunatBearerToken,
    );
  }

  async listWebhookSubscriptions(
    organizationId: string,
  ): Promise<readonly WebhookSubscriptionView[]> {
    const response = await this.request<{ readonly items: readonly WebhookSubscriptionView[] }>(
      this.environment.WEBHOOK_INTERNAL_URL,
      `/internal/organizations/${encodeURIComponent(organizationId)}/webhook-subscriptions`,
      { method: 'GET' },
      z.object({ items: z.array(webhookSubscriptionSchema) }),
      this.webhookBearerToken,
    );
    return response.items;
  }

  configureWebhookSubscription(
    organizationId: string,
    subscriptionId: string,
    input: ConfigureWebhookSubscription,
  ): Promise<WebhookSubscriptionView> {
    return this.request<WebhookSubscriptionView>(
      this.environment.WEBHOOK_INTERNAL_URL,
      `/internal/organizations/${encodeURIComponent(organizationId)}/webhook-subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: 'PUT', body: JSON.stringify(input) },
      webhookSubscriptionSchema,
      this.webhookBearerToken,
    );
  }

  private async request<T>(
    baseUrl: string,
    path: string,
    init: Pick<RequestInit, 'method' | 'body'>,
    responseSchema: z.ZodType<T>,
    bearerToken: string | undefined,
  ): Promise<T> {
    if (!bearerToken) {
      throw new ServiceUnavailableException('Internal service authentication is not configured');
    }

    let response: Response;
    try {
      response = await fetch(new URL(path, ensureTrailingSlash(baseUrl)), {
        ...init,
        headers: {
          authorization: `Bearer ${bearerToken}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.environment.INTERNAL_SERVICE_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException('An internal billing service is unavailable');
    }

    if (!response.ok) {
      throw new BadGatewayException({
        code: 'INTERNAL_SERVICE_REJECTED_REQUEST',
        message: 'An internal billing service rejected the request',
        upstreamStatus: response.status,
      });
    }

    try {
      const payload: unknown = await response.json();
      return responseSchema.parse(payload);
    } catch {
      throw new BadGatewayException('An internal billing service returned an invalid response');
    }
  }

  private loadBearerToken(path: string | undefined): string | undefined {
    if (!path) {
      return undefined;
    }
    const secret = readSecretFile(path, 32);
    try {
      return secret.toString('base64url');
    } finally {
      secret.fill(0);
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
