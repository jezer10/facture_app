import { parseWebhookEventEnvelope } from './webhook-validation';

describe('parseWebhookEventEnvelope', () => {
  it('preserves generic correlation and causation identifiers from the shared contract', () => {
    const envelope = parseWebhookEventEnvelope({
      causationId: 'command_123',
      correlationId: 'request_456',
      eventId: 'event_789',
      issuerId: '00000000-0000-4000-8000-000000000002',
      occurredAt: '2026-08-22T12:00:00.000Z',
      organizationId: '00000000-0000-4000-8000-000000000001',
      payload: {
        dataUrl: 'https://billing.example/documents/1',
        publicStatus: 'accepted',
        resourceId: '00000000-0000-4000-8000-000000000003',
        resourceType: 'fiscal-document',
      },
      payloadRef: 'organizations/1/documents/1.json',
      payloadSha256: 'A'.repeat(64),
      type: 'fiscal-document.accepted.v1',
      version: 1,
    });

    expect(envelope).toMatchObject({
      causationId: 'command_123',
      correlationId: 'request_456',
      eventId: 'event_789',
      payloadSha256: 'A'.repeat(64),
    });
  });

  it('accepts the received-document imported contract', () => {
    const envelope = parseWebhookEventEnvelope({
      correlationId: 'request_456',
      eventId: 'event_789',
      issuerId: '00000000-0000-4000-8000-000000000002',
      occurredAt: '2026-08-22T12:00:00.000Z',
      organizationId: '00000000-0000-4000-8000-000000000001',
      payload: {
        dataUrl:
          'https://billing.example/api/v1/received-documents/00000000-0000-4000-8000-000000000003',
        publicStatus: 'imported',
        resourceId: '00000000-0000-4000-8000-000000000003',
        resourceType: 'received-document',
      },
      payloadRef:
        'https://billing.example/api/v1/received-documents/00000000-0000-4000-8000-000000000003',
      payloadSha256: 'a'.repeat(64),
      type: 'received-document.imported.v1',
      version: 1,
    });

    expect(envelope.payload).toMatchObject({
      publicStatus: 'imported',
      resourceType: 'received-document',
    });
  });

  it('rejects an event type paired with another resource contract', () => {
    expect(() =>
      parseWebhookEventEnvelope({
        correlationId: 'request_456',
        eventId: 'event_789',
        issuerId: '00000000-0000-4000-8000-000000000002',
        occurredAt: '2026-08-22T12:00:00.000Z',
        organizationId: '00000000-0000-4000-8000-000000000001',
        payload: {
          dataUrl:
            'https://billing.example/api/v1/fiscal-documents/00000000-0000-4000-8000-000000000003',
          publicStatus: 'accepted',
          resourceId: '00000000-0000-4000-8000-000000000003',
          resourceType: 'fiscal-document',
        },
        payloadRef:
          'https://billing.example/api/v1/fiscal-documents/00000000-0000-4000-8000-000000000003',
        payloadSha256: 'a'.repeat(64),
        type: 'received-document.imported.v1',
        version: 1,
      }),
    ).toThrow('received-document.imported.v1 requires an imported received document');
  });
});
