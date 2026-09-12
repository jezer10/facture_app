import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IssuerEntity, REQUIRED_ADMIN, REQUIRED_SCOPES } from '@app/fiscal-core';
import type { AdministrationService, ApiKeyScope, MachinePrincipal } from '@app/fiscal-core';
import { AdministrativeIntegrationsController } from './administrative-integrations.controller';
import { ProvisionSunatCredentialDto } from './admin.dto';
import type {
  InternalBillingServicesClient,
  SunatCredentialStatus,
} from './internal-billing-services.client';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const ISSUER_ID = '22222222-2222-4222-8222-222222222222';

const PRINCIPAL: MachinePrincipal = {
  kind: 'service',
  organizationId: ORGANIZATION_ID,
  serviceAccountId: '33333333-3333-4333-8333-333333333333',
  apiKeyId: '44444444-4444-4444-8444-444444444444',
  scopes: new Set(['issuers:manage']),
};

describe('AdministrativeIntegrationsController', () => {
  it('uses the principal-aware issuer lookup before provisioning SUNAT credentials', async () => {
    const { administration, controller, internalServices } = createController();
    const issuer = activeIssuer();
    const body = Object.assign(new ProvisionSunatCredentialDto(), {
      environment: 'beta' as const,
      solUsername: 'MODDATOS',
      solPassword: 'secret',
    });
    const response = credentialStatus();
    administration.getIssuerForPrincipal.mockResolvedValue(issuer);
    internalServices.provisionSunatCredential.mockResolvedValue(response);

    await expect(controller.provisionSunatCredential(ISSUER_ID, body, PRINCIPAL)).resolves.toBe(
      response,
    );
    expect(administration.getIssuerForPrincipal).toHaveBeenCalledWith(PRINCIPAL, ISSUER_ID);
    expect(internalServices.provisionSunatCredential).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      ISSUER_ID,
      issuer.ruc,
      body,
    );
  });

  it('does not call SUNAT when the service account lacks an issuer grant', async () => {
    const { administration, controller, internalServices } = createController();
    administration.getIssuerForPrincipal.mockRejectedValue(
      new ForbiddenException('Service account is not authorized for this issuer'),
    );

    await expect(controller.getSunatCredential(ISSUER_ID, PRINCIPAL)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(internalServices.getSunatCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['provisionSunatCredential', 'issuers:manage'],
    ['getSunatCredential', 'issuers:manage'],
    ['listWebhookSubscriptions', 'webhooks:manage'],
    ['configureWebhookSubscription', 'webhooks:manage'],
  ] as const)('requires %s scope on %s', (methodName, scope) => {
    const reflector = new Reflector();
    const handler = AdministrativeIntegrationsController.prototype[methodName];

    expect(reflector.get<readonly ApiKeyScope[]>(REQUIRED_SCOPES, handler)).toEqual([scope]);
    expect(reflector.get<boolean>(REQUIRED_ADMIN, handler)).toBeUndefined();
  });

  it('does not impose the human-only admin guard at controller level', () => {
    const reflector = new Reflector();

    expect(reflector.get<boolean>(REQUIRED_ADMIN, AdministrativeIntegrationsController)).toBe(
      undefined,
    );
  });
});

interface ControllerHarness {
  readonly controller: AdministrativeIntegrationsController;
  readonly administration: jest.Mocked<Pick<AdministrationService, 'getIssuerForPrincipal'>>;
  readonly internalServices: jest.Mocked<
    Pick<
      InternalBillingServicesClient,
      | 'provisionSunatCredential'
      | 'getSunatCredential'
      | 'listWebhookSubscriptions'
      | 'configureWebhookSubscription'
    >
  >;
}

function createController(): ControllerHarness {
  const administration = {
    getIssuerForPrincipal: jest.fn(),
  } as jest.Mocked<Pick<AdministrationService, 'getIssuerForPrincipal'>>;
  const internalServices = {
    provisionSunatCredential: jest.fn(),
    getSunatCredential: jest.fn(),
    listWebhookSubscriptions: jest.fn(),
    configureWebhookSubscription: jest.fn(),
  } as jest.Mocked<
    Pick<
      InternalBillingServicesClient,
      | 'provisionSunatCredential'
      | 'getSunatCredential'
      | 'listWebhookSubscriptions'
      | 'configureWebhookSubscription'
    >
  >;

  return {
    administration,
    internalServices,
    controller: new AdministrativeIntegrationsController(
      administration as unknown as AdministrationService,
      internalServices as unknown as InternalBillingServicesClient,
    ),
  };
}

function activeIssuer(): IssuerEntity {
  return Object.assign(new IssuerEntity(), {
    id: ISSUER_ID,
    organizationId: ORGANIZATION_ID,
    ruc: '20131312955',
    legalName: 'ACME SAC',
    tradeName: null,
    address: {},
    active: true,
  });
}

function credentialStatus(): SunatCredentialStatus {
  return {
    issuerId: ISSUER_ID,
    issuerRuc: '20131312955',
    environment: 'beta',
    version: 1,
    active: true,
    hasCertificate: false,
    certificateArchiveSha256: null,
    certificateExpiresAt: null,
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}
