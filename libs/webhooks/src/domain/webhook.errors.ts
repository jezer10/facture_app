export type WebhookDeliveryErrorCode =
  | 'DELIVERY_BUSY'
  | 'DELIVERY_LEASE_LOST'
  | 'EVENT_ID_PAYLOAD_CONFLICT'
  | 'INVALID_EVENT'
  | 'INVALID_SUBSCRIPTION'
  | 'REPOSITORY_UNAVAILABLE'
  | 'REMOTE_CLIENT_ERROR'
  | 'REMOTE_RATE_LIMITED'
  | 'REMOTE_SERVER_ERROR'
  | 'REMOTE_TIMEOUT'
  | 'REMOTE_UNAVAILABLE'
  | 'TRANSIENT_DELIVERIES_FAILED'
  | 'UNSAFE_ENDPOINT';

export interface WebhookDeliveryErrorOptions {
  readonly cause?: unknown;
  readonly responseStatus?: number;
}

export abstract class WebhookDeliveryError extends Error {
  abstract readonly retryable: boolean;

  readonly code: WebhookDeliveryErrorCode;
  readonly responseStatus?: number;

  protected constructor(
    code: WebhookDeliveryErrorCode,
    message: string,
    options: WebhookDeliveryErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.responseStatus = options.responseStatus;
  }
}

export class TransientWebhookDeliveryError extends WebhookDeliveryError {
  readonly retryable = true;

  constructor(
    code: WebhookDeliveryErrorCode,
    message: string,
    options: WebhookDeliveryErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

export class PermanentWebhookDeliveryError extends WebhookDeliveryError {
  readonly retryable = false;

  constructor(
    code: WebhookDeliveryErrorCode,
    message: string,
    options: WebhookDeliveryErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

export function isWebhookDeliveryError(error: unknown): error is WebhookDeliveryError {
  return error instanceof WebhookDeliveryError;
}
