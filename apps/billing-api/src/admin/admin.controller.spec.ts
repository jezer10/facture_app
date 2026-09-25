import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { REQUIRED_ADMIN } from '@app/fiscal-core';
import type { AdministrationService, HumanPrincipal } from '@app/fiscal-core';
import { AdminController } from './admin.controller';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL: HumanPrincipal = {
  kind: 'human',
  subject: 'admin@example.test',
  organizationId: ORGANIZATION_ID,
  role: 'admin',
  platformAdmin: false,
};

describe('AdminController API-key creation', () => {
  it('forwards the Idempotency-Key to the transactional administration boundary', async () => {
    const createApiKey = jest.fn().mockResolvedValue({ id: 'api-key-id' });
    const controller = new AdminController({ createApiKey } as unknown as AdministrationService);

    await controller.createApiKey(
      SERVICE_ACCOUNT_ID,
      { scopes: ['documents:read'] },
      PRINCIPAL,
      'key-request-1',
    );

    expect(createApiKey).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
      PRINCIPAL,
      'key-request-1',
    );
  });

  it('forwards a missing header as an invalid empty value for service validation', async () => {
    const createApiKey = jest.fn().mockResolvedValue({ id: 'api-key-id' });
    const controller = new AdminController({ createApiKey } as unknown as AdministrationService);

    await controller.createApiKey(
      SERVICE_ACCOUNT_ID,
      { scopes: ['documents:read'] },
      PRINCIPAL,
      undefined,
    );

    expect(createApiKey).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      SERVICE_ACCOUNT_ID,
      ['documents:read'],
      null,
      PRINCIPAL,
      '',
    );
  });

  it('marks key mutation routes as administrative and revocation as HTTP 204', () => {
    const createApiKey = controllerMethod('createApiKey');
    const revokeApiKey = controllerMethod('revokeApiKey');
    expect(Reflect.getMetadata(REQUIRED_ADMIN, createApiKey)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_ADMIN, revokeApiKey)).toBe(true);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, revokeApiKey)).toBe(204);
  });
});

function controllerMethod(name: 'createApiKey' | 'revokeApiKey'): object {
  const descriptor = Object.getOwnPropertyDescriptor(AdminController.prototype, name) as
    | TypedPropertyDescriptor<(...args: unknown[]) => unknown>
    | undefined;
  if (!descriptor?.value) {
    throw new Error(`AdminController.${name} is not a method`);
  }
  return descriptor.value;
}
