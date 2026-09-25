export const WEBHOOK_SERVICE_ENVIRONMENT = Symbol('WEBHOOK_SERVICE_ENVIRONMENT');
export const INTERNAL_WEBHOOK_API_CREDENTIAL = Symbol('INTERNAL_WEBHOOK_API_CREDENTIAL');

export interface InternalWebhookApiCredential {
  readonly bearerToken?: string;
}
