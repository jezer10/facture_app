import type { WebhookEventEnvelope } from '@app/contracts';

import { WebhookDeliveryService } from './webhook-delivery.service';
import { verifyWebhookSignature } from './webhook-signature';
import type {
  WebhookTransport,
  WebhookTransportRequest,
  WebhookTransportResponse,
} from '../domain/webhook-transport';
import { WEBHOOK_HEADERS } from '../domain/webhook.constants';
import { TransientWebhookDeliveryError } from '../domain/webhook.errors';
import { InMemoryWebhookRepository } from '../infrastructure/in-memory-webhook.repository';

describe('WebhookDeliveryService', () => {
  const originalNodeEnvironment = process.env.NODE_ENV;
  const secret = 's'.repeat(32);
  const event: WebhookEventEnvelope = {
    correlationId: '00000000-0000-4000-8000-000000000003',
    eventId: 'evt_123',
    issuerId: '00000000-0000-4000-8000-000000000002',
    occurredAt: '2026-08-22T12:00:00.000Z',
    organizationId: '00000000-0000-4000-8000-000000000001',
    payload: {
      dataUrl: 'https://files.example.test/document.json',
      publicStatus: 'accepted',
      resourceId: '00000000-0000-4000-8000-000000000004',
      resourceType: 'fiscal-document',
    },
    payloadRef: 'organizations/tenant-1/documents/document-1.json',
    payloadSha256: 'a'.repeat(64),
    type: 'fiscal-document.accepted.v1',
    version: 1,
  };
  const now = new Date('2026-08-22T12:01:00.000Z');

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('delivers canonical JSON with a verifiable signature and skips duplicates', async () => {
    const repository = InMemoryWebhookRepository.create({
      environment: 'test',
      explicitlyEnabled: true,
    });
    await seedSubscription(repository, secret);
    const transport = new StubTransport([{ statusCode: 204 }]);
    const service = new WebhookDeliveryService(repository, transport, {
      now: () => now,
    });

    await expect(service.deliver(event, 1)).resolves.toEqual({
      delivered: 1,
      permanentlyFailed: 0,
      skipped: 0,
    });
    const restartedService = new WebhookDeliveryService(repository, transport, {
      now: () => now,
    });
    await expect(restartedService.deliver(event, 2, 2)).resolves.toEqual({
      delivered: 0,
      permanentlyFailed: 0,
      skipped: 1,
    });

    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    expect(request?.body).toBe(
      '{"correlationId":"00000000-0000-4000-8000-000000000003","eventId":"evt_123","issuerId":"00000000-0000-4000-8000-000000000002","occurredAt":"2026-08-22T12:00:00.000Z","organizationId":"00000000-0000-4000-8000-000000000001","payload":{"dataUrl":"https://files.example.test/document.json","publicStatus":"accepted","resourceId":"00000000-0000-4000-8000-000000000004","resourceType":"fiscal-document"},"payloadRef":"organizations/tenant-1/documents/document-1.json","payloadSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","type":"fiscal-document.accepted.v1","version":1}',
    );
    expect(
      verifyWebhookSignature({
        now,
        rawBody: request?.body ?? '',
        secret,
        signatureHeader: request?.headers[WEBHOOK_HEADERS.signature] ?? '',
        timestampHeader: request?.headers[WEBHOOK_HEADERS.timestamp] ?? '',
      }),
    ).toEqual({ valid: true });
  });

  it('records a permanent 4xx response without asking BullMQ to retry it', async () => {
    const repository = InMemoryWebhookRepository.create({
      environment: 'test',
      explicitlyEnabled: true,
    });
    await seedSubscription(repository, secret);
    const transport = new StubTransport([{ statusCode: 422 }]);
    const service = new WebhookDeliveryService(repository, transport, {
      now: () => now,
    });

    await expect(service.deliver(event, 1)).resolves.toEqual({
      delivered: 0,
      permanentlyFailed: 1,
      skipped: 0,
    });
    await expect(service.deliver(event, 2, 2)).resolves.toEqual({
      delivered: 0,
      permanentlyFailed: 0,
      skipped: 1,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('retries only a typed transient failure and keeps the event id stable', async () => {
    const repository = InMemoryWebhookRepository.create({
      environment: 'test',
      explicitlyEnabled: true,
    });
    await seedSubscription(repository, secret);
    const transport = new StubTransport([{ statusCode: 503 }, { statusCode: 204 }]);
    const service = new WebhookDeliveryService(repository, transport, {
      now: () => now,
    });

    await expect(service.deliver(event, 1, 2)).rejects.toBeInstanceOf(
      TransientWebhookDeliveryError,
    );
    await expect(service.deliver(event, 2, 2)).resolves.toMatchObject({
      delivered: 1,
    });

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.map((request) => request.headers[WEBHOOK_HEADERS.eventId])).toEqual([
      'evt_123',
      'evt_123',
    ]);
    await expect(
      repository.listDeliveryAttempts(
        event.organizationId,
        event.eventId,
        '00000000-0000-4000-8000-000000000005',
      ),
    ).resolves.toHaveLength(2);
  });

  it('never delivers a subscription returned from another organization', async () => {
    const repository = InMemoryWebhookRepository.create({
      environment: 'test',
      explicitlyEnabled: true,
    });
    jest.spyOn(repository, 'listActiveSubscriptions').mockResolvedValue([
      {
        createdAt: '2026-08-22T11:00:00.000Z',
        endpointUrl: 'https://example.test/webhooks',
        eventTypes: ['fiscal-document.accepted.v1'],
        id: '00000000-0000-4000-8000-000000000007',
        organizationId: '00000000-0000-4000-8000-000000000006',
        secret,
        status: 'active',
        updatedAt: '2026-08-22T11:00:00.000Z',
      },
    ]);
    const transport = new StubTransport([{ statusCode: 204 }]);
    const service = new WebhookDeliveryService(repository, transport, {
      now: () => now,
    });

    await expect(service.deliver(event, 1)).resolves.toMatchObject({
      delivered: 0,
      permanentlyFailed: 1,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('dead-letters an exhausted transient delivery and deduplicates later jobs', async () => {
    const repository = InMemoryWebhookRepository.create({
      environment: 'test',
      explicitlyEnabled: true,
    });
    await seedSubscription(repository, secret);
    const transport = new StubTransport([{ statusCode: 503 }, { statusCode: 503 }]);
    const service = new WebhookDeliveryService(repository, transport, {
      now: () => now,
    });

    await expect(service.deliver(event, 1, 2)).rejects.toBeInstanceOf(
      TransientWebhookDeliveryError,
    );
    await expect(service.deliver(event, 2, 2)).rejects.toBeInstanceOf(
      TransientWebhookDeliveryError,
    );

    await expect(
      repository.findDelivery(
        event.organizationId,
        event.eventId,
        '00000000-0000-4000-8000-000000000005',
      ),
    ).resolves.toMatchObject({ status: 'dead_letter' });
    await expect(
      repository.findDeadLetter(
        event.organizationId,
        event.eventId,
        '00000000-0000-4000-8000-000000000005',
      ),
    ).resolves.toMatchObject({ failureCode: 'REMOTE_SERVER_ERROR' });
    await expect(service.deliver(event, 2, 2)).resolves.toMatchObject({
      skipped: 1,
    });
    expect(transport.requests).toHaveLength(2);
  });

  it('allows only one concurrent claim for the same event and subscription', async () => {
    const repository = InMemoryWebhookRepository.create({
      environment: 'test',
      explicitlyEnabled: true,
    });
    await seedSubscription(repository, secret);
    const transport = new DeferredTransport();
    const firstService = new WebhookDeliveryService(repository, transport, {
      now: () => now,
    });
    const secondService = new WebhookDeliveryService(repository, transport, {
      now: () => now,
    });

    const firstDelivery = firstService.deliver(event, 1, 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(secondService.deliver(event, 1, 2)).rejects.toBeInstanceOf(
      TransientWebhookDeliveryError,
    );
    expect(transport.requests).toHaveLength(1);

    transport.resolve({ statusCode: 204 });
    await expect(firstDelivery).resolves.toMatchObject({ delivered: 1 });
  });
});

class StubTransport implements WebhookTransport {
  readonly requests: WebhookTransportRequest[] = [];

  constructor(private readonly responses: WebhookTransportResponse[]) {}

  post(request: WebhookTransportRequest): Promise<WebhookTransportResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error('Missing stub response');
    }
    return Promise.resolve(response);
  }
}

class DeferredTransport implements WebhookTransport {
  readonly requests: WebhookTransportRequest[] = [];
  private resolveResponse?: (response: WebhookTransportResponse) => void;

  post(request: WebhookTransportRequest): Promise<WebhookTransportResponse> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  resolve(response: WebhookTransportResponse): void {
    if (this.resolveResponse === undefined) {
      throw new Error('No webhook request is awaiting a response');
    }
    this.resolveResponse(response);
  }
}

async function seedSubscription(
  repository: InMemoryWebhookRepository,
  secret: string,
): Promise<void> {
  await repository.saveSubscription({
    createdAt: '2026-08-22T11:00:00.000Z',
    endpointUrl: 'https://example.test/webhooks',
    eventTypes: ['fiscal-document.accepted.v1'],
    id: '00000000-0000-4000-8000-000000000005',
    organizationId: '00000000-0000-4000-8000-000000000001',
    secret,
    status: 'active',
    updatedAt: '2026-08-22T11:00:00.000Z',
  });
}
