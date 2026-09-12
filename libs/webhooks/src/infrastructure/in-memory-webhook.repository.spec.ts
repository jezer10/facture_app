import { InMemoryWebhookRepository } from './in-memory-webhook.repository';
import {
  PermanentWebhookDeliveryError,
  TransientWebhookDeliveryError,
} from '../domain/webhook.errors';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const SUBSCRIPTION_ID = '00000000-0000-4000-8000-000000000002';

describe('InMemoryWebhookRepository', () => {
  const originalNodeEnvironment = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('fails closed outside test or explicit development', () => {
    process.env.NODE_ENV = 'production';

    expect(() =>
      InMemoryWebhookRepository.create({
        environment: 'development',
        explicitlyEnabled: true,
      }),
    ).toThrow(/restricted/);
  });

  it('rejects reuse of an event id with a different canonical body', async () => {
    process.env.NODE_ENV = 'test';
    const repository = createRepository();
    await repository.claimDelivery(claimInput({ bodySha256: 'a'.repeat(64) }));

    expect(() => repository.claimDelivery(claimInput({ bodySha256: 'b'.repeat(64) }))).toThrow(
      PermanentWebhookDeliveryError,
    );
  });

  it('reclaims an expired lease after a worker restart and rejects the stale owner', async () => {
    process.env.NODE_ENV = 'test';
    const repository = createRepository();
    const staleClaim = await repository.claimDelivery(claimInput());
    const recoveredClaim = await repository.claimDelivery(
      claimInput({
        leaseExpiresAt: '2026-08-22T12:01:15.000Z',
        startedAt: '2026-08-22T12:01:00.000Z',
      }),
    );

    expect(staleClaim.decision).toBe('claimed');
    expect(recoveredClaim.decision).toBe('claimed');
    if (staleClaim.decision !== 'claimed') {
      throw new Error('Expected the original delivery claim');
    }

    expect(() =>
      repository.completeDelivery({
        attemptId: staleClaim.attemptId,
        completedAt: '2026-08-22T12:01:01.000Z',
        eventId: 'evt_123',
        lockToken: staleClaim.lockToken,
        organizationId: ORGANIZATION_ID,
        status: 'delivered',
        subscriptionId: SUBSCRIPTION_ID,
      }),
    ).toThrow(TransientWebhookDeliveryError);
  });
});

function createRepository(): InMemoryWebhookRepository {
  return InMemoryWebhookRepository.create({
    environment: 'test',
    explicitlyEnabled: true,
  });
}

function claimInput(
  overrides: Partial<Parameters<InMemoryWebhookRepository['claimDelivery']>[0]> = {},
): Parameters<InMemoryWebhookRepository['claimDelivery']>[0] {
  return {
    attempt: 1,
    bodySha256: 'a'.repeat(64),
    eventId: 'evt_123',
    eventType: 'fiscal-document.accepted.v1',
    leaseExpiresAt: '2026-08-22T12:00:15.000Z',
    organizationId: ORGANIZATION_ID,
    rawBody: '{"eventId":"evt_123"}',
    startedAt: '2026-08-22T12:00:00.000Z',
    subscriptionId: SUBSCRIPTION_ID,
    ...overrides,
  };
}
