import type { Request } from 'express';

import type {
  AuthenticatedRequest,
  BillingPrincipal,
  ReceivedDocumentsService,
} from '@app/fiscal-core';

import { ReceivedController } from './received.controller';
import type { RequestReceivedSyncDto } from './received.dto';

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

describe('ReceivedController', () => {
  it('forwards Idempotency-Key and correlation context to the service', async () => {
    const service = {
      requestSync: jest.fn().mockResolvedValue({ id: 'sync-id' }),
    };
    const controller = new ReceivedController(service as unknown as ReceivedDocumentsService);
    const principal = {
      kind: 'service',
      organizationId: '22222222-2222-4222-8222-222222222222',
      serviceAccountId: '33333333-3333-4333-8333-333333333333',
      apiKeyId: '44444444-4444-4444-8444-444444444444',
      scopes: new Set(['received:sync'] as const),
    } satisfies BillingPrincipal;
    const body = {
      issuerId: '55555555-5555-4555-8555-555555555555',
      startDate: '2026-08-01',
      endDate: '2026-08-10',
      documentTypes: ['01'],
    } satisfies RequestReceivedSyncDto;
    const request = { correlationId: CORRELATION_ID } as Request & AuthenticatedRequest;

    await controller.requestSync(body, 'daily-import', principal, request);

    expect(service.requestSync).toHaveBeenCalledWith(
      principal,
      { ...body, idempotencyKey: 'daily-import' },
      CORRELATION_ID,
    );
  });
});
