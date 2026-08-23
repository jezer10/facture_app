import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { AdministrationService, CurrentPrincipal, RequireScopes } from '@app/fiscal-core';
import type { BillingPrincipal } from '@app/fiscal-core';
import { ConfigureWebhookSubscriptionDto, ProvisionSunatCredentialDto } from './admin.dto';
import {
  InternalBillingServicesClient,
  type SunatCredentialConfiguration,
  type SunatCredentialStatus,
  type WebhookSubscriptionView,
} from './internal-billing-services.client';

@Controller()
export class AdministrativeIntegrationsController {
  constructor(
    private readonly administration: AdministrationService,
    private readonly internalServices: InternalBillingServicesClient,
  ) {}

  @Put('issuers/:issuerId/sunat-credentials')
  @RequireScopes('issuers:manage')
  async provisionSunatCredential(
    @Param('issuerId', new ParseUUIDPipe()) issuerId: string,
    @Body() body: ProvisionSunatCredentialDto,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<SunatCredentialStatus> {
    const organizationId = requireOrganization(principal);
    const issuer = await this.administration.getIssuerForPrincipal(principal, issuerId);
    return this.internalServices.provisionSunatCredential(
      organizationId,
      issuer.id,
      issuer.ruc,
      body,
    );
  }

  @Get('issuers/:issuerId/sunat-credentials')
  @RequireScopes('issuers:manage')
  async getSunatCredential(
    @Param('issuerId', new ParseUUIDPipe()) issuerId: string,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<SunatCredentialConfiguration> {
    await this.administration.getIssuerForPrincipal(principal, issuerId);
    return this.internalServices.getSunatCredential(issuerId);
  }

  @Get('webhook-subscriptions')
  @RequireScopes('webhooks:manage')
  listWebhookSubscriptions(
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<readonly WebhookSubscriptionView[]> {
    return this.internalServices.listWebhookSubscriptions(requireOrganization(principal));
  }

  @Put('webhook-subscriptions/:subscriptionId')
  @RequireScopes('webhooks:manage')
  configureWebhookSubscription(
    @Param('subscriptionId', new ParseUUIDPipe()) subscriptionId: string,
    @Body() body: ConfigureWebhookSubscriptionDto,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<WebhookSubscriptionView> {
    return this.internalServices.configureWebhookSubscription(
      requireOrganization(principal),
      subscriptionId,
      body,
    );
  }
}

function requireOrganization(principal: BillingPrincipal): string {
  if (!principal.organizationId) {
    throw new Error('An organization context is required');
  }
  return principal.organizationId;
}
