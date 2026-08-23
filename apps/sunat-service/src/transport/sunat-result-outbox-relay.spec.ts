import { Logger } from '@nestjs/common';
import type { SunatResultEnvelope } from '@app/contracts';
import type {
  CompletedSunatCommand,
  PendingCommandDelivery,
  SunatCommandLedgerPort,
} from '@app/sunat';
import type { BullMqSunatEventPublisher } from './bullmq-sunat-event-publisher';
import { SunatResultOutboxRelay } from './sunat-result-outbox-relay';

describe('SunatResultOutboxRelay', () => {
  it('redrives a durable result after a transient publish failure', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const firstAttempt = delivery(1);
    const secondAttempt = delivery(2);
    const claimPendingDeliveries = jest
      .fn()
      .mockResolvedValueOnce([firstAttempt])
      .mockResolvedValueOnce([secondAttempt]);
    const rescheduleDelivery = jest.fn().mockResolvedValue(undefined);
    const markDelivered = jest.fn().mockResolvedValue(undefined);
    const publishResult = jest
      .fn()
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValueOnce(undefined);
    const relay = new SunatResultOutboxRelay(
      {
        claimPendingDeliveries,
        rescheduleDelivery,
        markDelivered,
      } as unknown as SunatCommandLedgerPort<CompletedSunatCommand>,
      {
        publishResult,
        publishFollowUp: jest.fn(),
      } as unknown as BullMqSunatEventPublisher,
    );

    await relay.publishPendingDeliveries();

    expect(rescheduleDelivery).toHaveBeenCalledWith(
      firstAttempt.eventId,
      'SUNAT_RESULT_PUBLISH_FAILED',
      expect.any(Date),
    );
    expect(markDelivered).not.toHaveBeenCalled();

    await relay.publishPendingDeliveries();

    expect(publishResult).toHaveBeenLastCalledWith(secondAttempt.result.result);
    expect(markDelivered).toHaveBeenCalledWith(secondAttempt.eventId);
  });
});

function delivery(attempt: number): PendingCommandDelivery<CompletedSunatCommand> {
  return {
    eventId: 'command-1',
    attempt,
    result: { result: resultFixture() },
  };
}

function resultFixture(): SunatResultEnvelope {
  return {
    eventId: 'result-1',
    type: 'sunat.document.failed.v1',
    version: 1,
    occurredAt: '2026-08-22T00:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'command-1',
    organizationId: '11111111-1111-4111-8111-111111111111',
    issuerId: '22222222-2222-4222-8222-222222222222',
    payloadRef: 'sunat/results/result-1.json',
    payloadSha256: 'a'.repeat(64),
    payload: {
      documentId: '33333333-3333-4333-8333-333333333333',
      code: 'TEST_FAILURE',
      description: 'safe failure',
      retryable: false,
    },
  };
}
