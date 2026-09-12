import type {
  ClaimWebhookDeliveryInput,
  CompleteWebhookDeliveryInput,
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryClaim,
  WebhookDeadLetter,
} from './webhook-delivery';
import type { WebhookSubscription } from './webhook-subscription';

export const WEBHOOK_REPOSITORY = Symbol('WEBHOOK_REPOSITORY');

export interface SaveWebhookSubscriptionOptions {
  readonly secretWasProvided: boolean;
}

export interface WebhookRepository {
  checkHealth(): Promise<void>;
  claimDelivery(input: ClaimWebhookDeliveryInput): Promise<WebhookDeliveryClaim>;
  completeDelivery(input: CompleteWebhookDeliveryInput): Promise<void>;
  findDelivery(
    organizationId: string,
    eventId: string,
    subscriptionId: string,
  ): Promise<WebhookDelivery | undefined>;
  findSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<WebhookSubscription | undefined>;
  findDeadLetter(
    organizationId: string,
    eventId: string,
    subscriptionId: string,
  ): Promise<WebhookDeadLetter | undefined>;
  listActiveSubscriptions(
    organizationId: string,
    eventType: string,
  ): Promise<readonly WebhookSubscription[]>;
  listSubscriptions(organizationId: string): Promise<readonly WebhookSubscription[]>;
  listDeliveryAttempts(
    organizationId: string,
    eventId: string,
    subscriptionId: string,
  ): Promise<readonly WebhookDeliveryAttempt[]>;
  saveSubscription(
    subscription: WebhookSubscription,
    options?: SaveWebhookSubscriptionOptions,
  ): Promise<WebhookSubscription>;
}
