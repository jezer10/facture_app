export type WebhookDeliveryStatus =
  | 'dead_letter'
  | 'delivered'
  | 'permanent_failure'
  | 'processing'
  | 'transient_failure';

export interface WebhookDelivery {
  readonly attempt: number;
  readonly bodySha256: string;
  readonly deliveredAt?: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly failureCode?: string;
  readonly firstAttemptAt: string;
  readonly lastAttemptAt: string;
  readonly leaseExpiresAt?: string;
  readonly lockToken?: string;
  readonly organizationId: string;
  readonly rawBody: string;
  readonly responseStatus?: number;
  readonly status: WebhookDeliveryStatus;
  readonly subscriptionId: string;
}

export function isFinalWebhookDelivery(delivery: WebhookDelivery): boolean {
  return (
    delivery.status === 'dead_letter' ||
    delivery.status === 'delivered' ||
    delivery.status === 'permanent_failure'
  );
}

export interface ClaimWebhookDeliveryInput {
  readonly attempt: number;
  readonly bodySha256: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly leaseExpiresAt: string;
  readonly organizationId: string;
  readonly rawBody: string;
  readonly startedAt: string;
  readonly subscriptionId: string;
}

export type WebhookDeliveryClaim =
  | { readonly decision: 'busy' }
  | { readonly decision: 'final' }
  | {
      readonly attemptId: string;
      readonly decision: 'claimed';
      readonly lockToken: string;
    };

export interface CompleteWebhookDeliveryInput {
  readonly attemptId: string;
  readonly completedAt: string;
  readonly eventId: string;
  readonly failureCode?: string;
  readonly lockToken: string;
  readonly organizationId: string;
  readonly responseStatus?: number;
  readonly status: 'dead_letter' | 'delivered' | 'permanent_failure' | 'transient_failure';
  readonly subscriptionId: string;
}

export interface WebhookDeliveryAttempt {
  readonly attempt: number;
  readonly completedAt?: string;
  readonly eventId: string;
  readonly failureCode?: string;
  readonly id: string;
  readonly organizationId: string;
  readonly responseStatus?: number;
  readonly startedAt: string;
  readonly status: WebhookDeliveryStatus;
  readonly subscriptionId: string;
}

export interface WebhookDeadLetter {
  readonly createdAt: string;
  readonly eventId: string;
  readonly failureCode: string;
  readonly id: string;
  readonly organizationId: string;
  readonly subscriptionId: string;
}
