export const WEBHOOK_EVENT_SCHEMA_VERSION = 1 as const;
export const WEBHOOK_SIGNATURE_VERSION = 'v1' as const;

export const WEBHOOK_HEADERS = {
  eventId: 'x-billing-event-id',
  eventType: 'x-billing-event-type',
  signature: 'x-billing-signature',
  timestamp: 'x-billing-timestamp',
  version: 'x-billing-webhook-version',
} as const;

export const DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
export const DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
