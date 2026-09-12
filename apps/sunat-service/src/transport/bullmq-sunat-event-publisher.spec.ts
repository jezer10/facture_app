import type { Queue } from 'bullmq';
import {
  SUNAT_RESULT_JOB,
  type SunatCommandEnvelope,
  type SunatResultEnvelope,
} from '@app/contracts';
import { BullMqSunatEventPublisher } from './bullmq-sunat-event-publisher';

describe('BullMqSunatEventPublisher', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = { ...originalEnvironment };
    delete process.env.SUNAT_RESULT_ATTEMPTS;
    delete process.env.SUNAT_RESULT_BACKOFF_MS;
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('publishes result jobs with bounded retries, backoff, and retained failures', async () => {
    const resultQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const publisher = new BullMqSunatEventPublisher(
      resultQueue as unknown as Queue<SunatResultEnvelope>,
      { add: jest.fn() } as unknown as Queue<SunatCommandEnvelope>,
    );
    const result = resultFixture();

    await publisher.publishResult(result);

    expect(resultQueue.add).toHaveBeenCalledWith(SUNAT_RESULT_JOB, result, {
      jobId: result.eventId,
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100_000 },
      removeOnFail: false,
    });
  });
});

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
