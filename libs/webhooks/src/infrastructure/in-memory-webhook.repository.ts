import { randomUUID } from 'node:crypto';

import type {
  ClaimWebhookDeliveryInput,
  CompleteWebhookDeliveryInput,
  WebhookDeadLetter,
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryClaim,
} from '../domain/webhook-delivery';
import type { WebhookRepository } from '../domain/webhook-repository';
import type { WebhookSubscription } from '../domain/webhook-subscription';
import {
  PermanentWebhookDeliveryError,
  TransientWebhookDeliveryError,
} from '../domain/webhook.errors';

type AllowedInMemoryEnvironment = 'development' | 'test';

export interface InMemoryWebhookRepositoryOptions {
  readonly environment: AllowedInMemoryEnvironment;
  readonly explicitlyEnabled: true;
}

export class InMemoryWebhookRepository implements WebhookRepository {
  private readonly attempts = new Map<string, WebhookDeliveryAttempt>();
  private readonly deadLetters = new Map<string, WebhookDeadLetter>();
  private readonly deliveries = new Map<string, WebhookDelivery>();
  private readonly subscriptions = new Map<string, WebhookSubscription>();

  private constructor() {}

  static create(options: InMemoryWebhookRepositoryOptions): InMemoryWebhookRepository {
    if (options.explicitlyEnabled !== true || process.env.NODE_ENV !== options.environment) {
      throw new Error(
        'The in-memory webhook repository is restricted to an explicitly enabled test or development environment',
      );
    }

    return new InMemoryWebhookRepository();
  }

  checkHealth(): Promise<void> {
    return Promise.resolve();
  }

  claimDelivery(input: ClaimWebhookDeliveryInput): Promise<WebhookDeliveryClaim> {
    const key = deliveryKey(input.organizationId, input.eventId, input.subscriptionId);
    const existing = this.deliveries.get(key);

    if (existing !== undefined && existing.bodySha256 !== input.bodySha256) {
      throw new PermanentWebhookDeliveryError(
        'EVENT_ID_PAYLOAD_CONFLICT',
        'A webhook event ID was reused with a different canonical payload',
      );
    }
    if (
      existing?.status === 'dead_letter' ||
      existing?.status === 'delivered' ||
      existing?.status === 'permanent_failure'
    ) {
      return Promise.resolve({ decision: 'final' });
    }
    if (
      existing?.status === 'processing' &&
      existing.leaseExpiresAt !== undefined &&
      Date.parse(existing.leaseExpiresAt) > Date.parse(input.startedAt)
    ) {
      return Promise.resolve({ decision: 'busy' });
    }

    const attemptId = randomUUID();
    const lockToken = randomUUID();
    this.deliveries.set(key, {
      attempt: input.attempt,
      bodySha256: input.bodySha256,
      eventId: input.eventId,
      eventType: input.eventType,
      firstAttemptAt: existing?.firstAttemptAt ?? input.startedAt,
      lastAttemptAt: input.startedAt,
      leaseExpiresAt: input.leaseExpiresAt,
      lockToken,
      organizationId: input.organizationId,
      rawBody: input.rawBody,
      status: 'processing',
      subscriptionId: input.subscriptionId,
    });
    this.attempts.set(attemptId, {
      attempt: input.attempt,
      eventId: input.eventId,
      id: attemptId,
      organizationId: input.organizationId,
      startedAt: input.startedAt,
      status: 'processing',
      subscriptionId: input.subscriptionId,
    });

    return Promise.resolve({ attemptId, decision: 'claimed', lockToken });
  }

  completeDelivery(input: CompleteWebhookDeliveryInput): Promise<void> {
    const key = deliveryKey(input.organizationId, input.eventId, input.subscriptionId);
    const delivery = this.deliveries.get(key);
    const attempt = this.attempts.get(input.attemptId);

    if (
      delivery?.status !== 'processing' ||
      delivery.lockToken !== input.lockToken ||
      attempt === undefined ||
      attempt.eventId !== input.eventId ||
      attempt.organizationId !== input.organizationId ||
      attempt.subscriptionId !== input.subscriptionId
    ) {
      throw new TransientWebhookDeliveryError(
        'DELIVERY_LEASE_LOST',
        'Webhook delivery lease was lost before completion',
      );
    }

    this.deliveries.set(key, {
      attempt: delivery.attempt,
      bodySha256: delivery.bodySha256,
      ...(input.status === 'delivered' ? { deliveredAt: input.completedAt } : {}),
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      firstAttemptAt: delivery.firstAttemptAt,
      lastAttemptAt: input.completedAt,
      organizationId: delivery.organizationId,
      rawBody: delivery.rawBody,
      ...(input.responseStatus === undefined ? {} : { responseStatus: input.responseStatus }),
      status: input.status,
      subscriptionId: delivery.subscriptionId,
    });
    this.attempts.set(input.attemptId, {
      ...attempt,
      completedAt: input.completedAt,
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      ...(input.responseStatus === undefined ? {} : { responseStatus: input.responseStatus }),
      status: input.status,
    });

    if (input.status === 'dead_letter' || input.status === 'permanent_failure') {
      this.deadLetters.set(key, {
        createdAt: input.completedAt,
        eventId: input.eventId,
        failureCode: input.failureCode ?? 'UNCLASSIFIED_FAILURE',
        id: this.deadLetters.get(key)?.id ?? randomUUID(),
        organizationId: input.organizationId,
        subscriptionId: input.subscriptionId,
      });
    }

    return Promise.resolve();
  }

  findDeadLetter(
    organizationId: string,
    eventId: string,
    subscriptionId: string,
  ): Promise<WebhookDeadLetter | undefined> {
    const deadLetter = this.deadLetters.get(deliveryKey(organizationId, eventId, subscriptionId));
    return Promise.resolve(deadLetter === undefined ? undefined : { ...deadLetter });
  }

  findDelivery(
    organizationId: string,
    eventId: string,
    subscriptionId: string,
  ): Promise<WebhookDelivery | undefined> {
    const delivery = this.deliveries.get(deliveryKey(organizationId, eventId, subscriptionId));
    return Promise.resolve(delivery === undefined ? undefined : cloneDelivery(delivery));
  }

  findSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<WebhookSubscription | undefined> {
    const subscription = this.subscriptions.get(subscriptionKey(organizationId, subscriptionId));
    return Promise.resolve(
      subscription === undefined ? undefined : cloneSubscription(subscription),
    );
  }

  listActiveSubscriptions(
    organizationId: string,
    eventType: string,
  ): Promise<readonly WebhookSubscription[]> {
    return Promise.resolve(
      [...this.subscriptions.values()]
        .filter(
          (subscription) =>
            subscription.organizationId === organizationId &&
            subscription.status === 'active' &&
            subscription.eventTypes.includes(eventType),
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(cloneSubscription),
    );
  }

  listDeliveryAttempts(
    organizationId: string,
    eventId: string,
    subscriptionId: string,
  ): Promise<readonly WebhookDeliveryAttempt[]> {
    return Promise.resolve(
      [...this.attempts.values()]
        .filter(
          (attempt) =>
            attempt.organizationId === organizationId &&
            attempt.eventId === eventId &&
            attempt.subscriptionId === subscriptionId,
        )
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .map((attempt) => ({ ...attempt })),
    );
  }

  listSubscriptions(organizationId: string): Promise<readonly WebhookSubscription[]> {
    return Promise.resolve(
      [...this.subscriptions.values()]
        .filter((subscription) => subscription.organizationId === organizationId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(cloneSubscription),
    );
  }

  saveSubscription(subscription: WebhookSubscription): Promise<WebhookSubscription> {
    const saved = cloneSubscription(subscription);
    this.subscriptions.set(subscriptionKey(subscription.organizationId, subscription.id), saved);
    return Promise.resolve(cloneSubscription(saved));
  }
}

function deliveryKey(organizationId: string, eventId: string, subscriptionId: string): string {
  return JSON.stringify([organizationId, eventId, subscriptionId]);
}

function subscriptionKey(organizationId: string, subscriptionId: string): string {
  return JSON.stringify([organizationId, subscriptionId]);
}

function cloneDelivery(delivery: WebhookDelivery): WebhookDelivery {
  return { ...delivery };
}

function cloneSubscription(subscription: WebhookSubscription): WebhookSubscription {
  return { ...subscription, eventTypes: [...subscription.eventTypes] };
}
