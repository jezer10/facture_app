export const WEBHOOK_TRANSPORT = Symbol('WEBHOOK_TRANSPORT');

export interface WebhookTransportRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly url: string;
}

export interface WebhookTransportResponse {
  readonly statusCode: number;
}

export interface WebhookTransport {
  post(request: WebhookTransportRequest): Promise<WebhookTransportResponse>;
}
