import {
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  AdministrationService,
  CurrentPrincipal,
  RequireAdmin,
  RequirePlatformAdmin,
} from '@app/fiscal-core';
import type { BillingPrincipal, HumanPrincipal } from '@app/fiscal-core';
import type {
  CreatedApiKey,
  IssuerEntity,
  IssuerSeriesEntity,
  OrganizationEntity,
  ServiceAccountEntity,
  ServiceAccountIssuerGrantEntity,
} from '@app/fiscal-core';
import {
  CreateApiKeyDto,
  CreateIssuerDto,
  CreateIssuerSeriesDto,
  CreateOrganizationDto,
  CreateServiceAccountDto,
  GrantIssuerDto,
} from './admin.dto';

@Controller()
export class AdminController {
  constructor(private readonly administration: AdministrationService) {}

  @Post('organizations')
  @RequirePlatformAdmin()
  createOrganization(
    @Body() body: CreateOrganizationDto,
    @CurrentPrincipal() principal: HumanPrincipal,
  ): Promise<OrganizationEntity> {
    return this.administration.createOrganization(body, principal.subject);
  }

  @Post('service-accounts')
  @RequireAdmin()
  createServiceAccount(
    @Body() body: CreateServiceAccountDto,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<ServiceAccountEntity> {
    return this.administration.createServiceAccount(
      requireOrganization(principal),
      body.name,
      principal,
    );
  }

  @Post('issuers')
  @RequireAdmin()
  createIssuer(
    @Body() body: CreateIssuerDto,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<IssuerEntity> {
    return this.administration.createIssuer(requireOrganization(principal), body, principal);
  }

  @Post('issuers/:issuerId/series')
  @RequireAdmin()
  createSeries(
    @Param('issuerId', new ParseUUIDPipe()) issuerId: string,
    @Body() body: CreateIssuerSeriesDto,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<IssuerSeriesEntity> {
    return this.administration.createSeries(
      requireOrganization(principal),
      issuerId,
      body.documentType,
      body.series,
      body.nextNumber,
      principal,
    );
  }

  @Post('service-accounts/:serviceAccountId/issuer-grants')
  @RequireAdmin()
  grantIssuer(
    @Param('serviceAccountId', new ParseUUIDPipe()) serviceAccountId: string,
    @Body() body: GrantIssuerDto,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<ServiceAccountIssuerGrantEntity> {
    return this.administration.grantIssuer(
      requireOrganization(principal),
      serviceAccountId,
      body.issuerId,
      principal,
    );
  }

  @Post('service-accounts/:serviceAccountId/api-keys')
  @RequireAdmin()
  createApiKey(
    @Param('serviceAccountId', new ParseUUIDPipe()) serviceAccountId: string,
    @Body() body: CreateApiKeyDto,
    @CurrentPrincipal() principal: BillingPrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<CreatedApiKey> {
    return this.administration.createApiKey(
      requireOrganization(principal),
      serviceAccountId,
      body.scopes,
      body.expiresAt ? new Date(body.expiresAt) : null,
      principal,
      idempotencyKey ?? '',
    );
  }

  @Delete('api-keys/:apiKeyId')
  @HttpCode(204)
  @RequireAdmin()
  async revokeApiKey(
    @Param('apiKeyId', new ParseUUIDPipe()) apiKeyId: string,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<void> {
    await this.administration.revokeApiKey(requireOrganization(principal), apiKeyId, principal);
  }
}

function requireOrganization(principal: BillingPrincipal): string {
  if (!principal.organizationId) {
    throw new Error('An organization context is required');
  }
  return principal.organizationId;
}
