export type WebhookSubscriptionStatus = 'active' | 'disabled';

export interface WebhookSubscription {
  readonly createdAt: string;
  readonly endpointUrl: string;
  readonly eventTypes: readonly string[];
  readonly id: string;
  readonly organizationId: string;
  readonly secret: string;
  readonly status: WebhookSubscriptionStatus;
  readonly updatedAt: string;
}

export interface WebhookSubscriptionView {
  readonly createdAt: string;
  readonly endpointUrl: string;
  readonly eventTypes: readonly string[];
  readonly id: string;
  readonly organizationId: string;
  readonly status: WebhookSubscriptionStatus;
  readonly updatedAt: string;
}

export interface ConfigureWebhookSubscriptionInput {
  readonly enabled: boolean;
  readonly endpointUrl: string;
  readonly eventTypes: readonly string[];
  readonly secret?: string;
}

export function toWebhookSubscriptionView(
  subscription: WebhookSubscription,
): WebhookSubscriptionView {
  return {
    createdAt: subscription.createdAt,
    endpointUrl: subscription.endpointUrl,
    eventTypes: subscription.eventTypes,
    id: subscription.id,
    organizationId: subscription.organizationId,
    status: subscription.status,
    updatedAt: subscription.updatedAt,
  };
}
