import type { EventEnvelope } from './event-envelope';

export type WebhookEventType =
  | 'fiscal-document.processing.v1'
  | 'fiscal-document.accepted.v1'
  | 'fiscal-document.rejected.v1'
  | 'fiscal-document.failed.v1'
  | 'fiscal-document.voided.v1'
  | 'received-document.imported.v1';

export interface WebhookEventPayload {
  readonly resourceId: string;
  readonly resourceType: 'fiscal-document' | 'received-document';
  readonly publicStatus: string;
  readonly dataUrl: string;
}

export type WebhookEventEnvelope = EventEnvelope<WebhookEventType, WebhookEventPayload>;
