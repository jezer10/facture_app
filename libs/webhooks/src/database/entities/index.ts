export * from './webhook.entities';

import {
  WebhookDeadLetterEntity,
  WebhookDeliveryAttemptEntity,
  WebhookDeliveryEntity,
  WebhookSecretVersionEntity,
  WebhookSubscriptionEntity,
} from './webhook.entities';

export const WEBHOOK_ENTITIES = [
  WebhookSubscriptionEntity,
  WebhookSecretVersionEntity,
  WebhookDeliveryEntity,
  WebhookDeliveryAttemptEntity,
  WebhookDeadLetterEntity,
] as const;
