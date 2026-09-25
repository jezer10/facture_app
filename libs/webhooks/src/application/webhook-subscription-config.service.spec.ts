import { WebhookSubscriptionConfigurationService } from './webhook-subscription-config.service';
import { PermanentWebhookDeliveryError } from '../domain/webhook.errors';
import { InMemoryWebhookRepository } from '../infrastructure/in-memory-webhook.repository';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000002';
const SUBSCRIPTION_ID = '00000000-0000-4000-8000-000000000003';

describe('WebhookSubscriptionConfigurationService', () => {
  const originalNodeEnvironment = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('never returns the write-only signing secret', async () => {
    const repository = createRepository();
    const service = new WebhookSubscriptionConfigurationService(repository, {
      allowInsecureHttp: false,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    const view = await service.configure(ORGANIZATION_ID, SUBSCRIPTION_ID, {
      enabled: true,
      endpointUrl: 'https://example.test/webhooks',
      eventTypes: ['fiscal-document.accepted.v1'],
      secret: 's'.repeat(32),
    });

    expect(view).not.toHaveProperty('secret');
    expect(await service.list(ORGANIZATION_ID)).toEqual([view]);
    expect(await service.list(OTHER_ORGANIZATION_ID)).toEqual([]);
  });

  it('retains the existing secret when an update omits it', async () => {
    const repository = createRepository();
    const service = new WebhookSubscriptionConfigurationService(repository, {
      allowInsecureHttp: false,
    });
    const secret = 's'.repeat(32);
    await service.configure(ORGANIZATION_ID, SUBSCRIPTION_ID, {
      enabled: true,
      endpointUrl: 'https://example.test/first',
      eventTypes: ['fiscal-document.accepted.v1'],
      secret,
    });

    await service.configure(ORGANIZATION_ID, SUBSCRIPTION_ID, {
      enabled: false,
      endpointUrl: 'https://example.test/second',
      eventTypes: ['fiscal-document.rejected.v1'],
    });

    await expect(
      repository.findSubscription(ORGANIZATION_ID, SUBSCRIPTION_ID),
    ).resolves.toMatchObject({
      secret,
      status: 'disabled',
    });
  });

  it('allows subscriptions to processing and newly imported received documents', async () => {
    const repository = createRepository();
    const service = new WebhookSubscriptionConfigurationService(repository, {
      allowInsecureHttp: false,
    });

    const view = await service.configure(ORGANIZATION_ID, SUBSCRIPTION_ID, {
      enabled: true,
      endpointUrl: 'https://example.test/billing-events',
      eventTypes: ['fiscal-document.processing.v1', 'received-document.imported.v1'],
      secret: 's'.repeat(32),
    });

    expect(view.eventTypes).toEqual([
      'fiscal-document.processing.v1',
      'received-document.imported.v1',
    ]);
  });

  it('rejects insecure endpoints unless development explicitly permits them', async () => {
    const repository = createRepository();
    const service = new WebhookSubscriptionConfigurationService(repository, {
      allowInsecureHttp: false,
    });

    await expect(
      service.configure(ORGANIZATION_ID, SUBSCRIPTION_ID, {
        enabled: true,
        endpointUrl: 'http://localhost:3001/webhooks',
        eventTypes: ['fiscal-document.accepted.v1'],
        secret: 's'.repeat(32),
      }),
    ).rejects.toBeInstanceOf(PermanentWebhookDeliveryError);
  });

  it('rejects endpoint URLs that could hide credentials in their query', async () => {
    const repository = createRepository();
    const service = new WebhookSubscriptionConfigurationService(repository, {
      allowInsecureHttp: false,
    });

    await expect(
      service.configure(ORGANIZATION_ID, SUBSCRIPTION_ID, {
        enabled: true,
        endpointUrl: 'https://example.test/webhooks?credential=hidden',
        eventTypes: ['fiscal-document.accepted.v1'],
        secret: 's'.repeat(32),
      }),
    ).rejects.toBeInstanceOf(PermanentWebhookDeliveryError);
  });
});

function createRepository(): InMemoryWebhookRepository {
  return InMemoryWebhookRepository.create({
    environment: 'test',
    explicitlyEnabled: true,
  });
}
