import type { WebhookEventEnvelope } from '@app/contracts';
import { createHash } from 'node:crypto';

import { canonicalJsonStringify } from './canonical-json';
import { createWebhookHeaders } from './webhook-signature';
import { parseWebhookEventEnvelope } from './webhook-validation';
import type { WebhookRepository } from '../domain/webhook-repository';
import { normalizeWebhookEndpointUrl } from '../domain/webhook-endpoint';
import type { WebhookSubscription } from '../domain/webhook-subscription';
import type { WebhookTransport } from '../domain/webhook-transport';
import { DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS } from '../domain/webhook.constants';
import {
  isWebhookDeliveryError,
  PermanentWebhookDeliveryError,
  TransientWebhookDeliveryError,
  type WebhookDeliveryError,
} from '../domain/webhook.errors';

export interface WebhookDeliveryServiceOptions {
  readonly allowInsecureHttp?: boolean;
  readonly deliveryLeaseMs?: number;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
}

export interface WebhookDeliverySummary {
  readonly delivered: number;
  readonly permanentlyFailed: number;
  readonly skipped: number;
}

export class WebhookDeliveryService {
  private readonly allowInsecureHttp: boolean;
  private readonly deliveryLeaseMs: number;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly repository: WebhookRepository,
    private readonly transport: WebhookTransport,
    options: WebhookDeliveryServiceOptions = {},
  ) {
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS;
    this.deliveryLeaseMs = options.deliveryLeaseMs ?? this.requestTimeoutMs + 5_000;

    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new RangeError('Webhook request timeout must be a positive integer');
    }
    if (!Number.isInteger(this.deliveryLeaseMs) || this.deliveryLeaseMs <= this.requestTimeoutMs) {
      throw new RangeError('Webhook delivery lease must exceed the request timeout');
    }
  }

  async deliver(
    untrustedEvent: WebhookEventEnvelope,
    attempt: number,
    maximumAttempts = 1,
  ): Promise<WebhookDeliverySummary> {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new PermanentWebhookDeliveryError(
        'INVALID_EVENT',
        'Webhook delivery attempt must be a positive integer',
      );
    }
    if (!Number.isInteger(maximumAttempts) || maximumAttempts < attempt) {
      throw new PermanentWebhookDeliveryError(
        'INVALID_EVENT',
        'Webhook maximum attempts must be greater than or equal to the current attempt',
      );
    }

    const event = parseWebhookEventEnvelope(untrustedEvent);
    const rawBody = canonicalJsonStringify(event);
    const bodySha256 = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    const subscriptions = await this.callRepository(() =>
      this.repository.listActiveSubscriptions(event.organizationId, event.type),
    );
    const summary = {
      delivered: 0,
      permanentlyFailed: 0,
      skipped: 0,
    };
    const transientFailures: TransientWebhookDeliveryError[] = [];

    for (const subscription of subscriptions) {
      try {
        assertSubscriptionScope(event, subscription);
      } catch (error) {
        if (error instanceof PermanentWebhookDeliveryError) {
          summary.permanentlyFailed += 1;
          continue;
        }
        throw error;
      }

      const attemptedAt = this.now();
      const claim = await this.callRepository(() =>
        this.repository.claimDelivery({
          attempt,
          bodySha256,
          eventId: event.eventId,
          eventType: event.type,
          leaseExpiresAt: new Date(attemptedAt.getTime() + this.deliveryLeaseMs).toISOString(),
          organizationId: event.organizationId,
          rawBody,
          startedAt: attemptedAt.toISOString(),
          subscriptionId: subscription.id,
        }),
      );

      if (claim.decision === 'final') {
        summary.skipped += 1;
        continue;
      }
      if (claim.decision === 'busy') {
        transientFailures.push(
          new TransientWebhookDeliveryError(
            'DELIVERY_BUSY',
            'Webhook delivery is already being processed',
          ),
        );
        continue;
      }

      try {
        const statusCode = await this.deliverToSubscription(
          event,
          subscription,
          rawBody,
          attemptedAt.toISOString(),
        );
        await this.completeDelivery({
          attemptId: claim.attemptId,
          completedAt: this.now().toISOString(),
          event,
          lockToken: claim.lockToken,
          responseStatus: statusCode,
          status: 'delivered',
          subscription,
        });
        summary.delivered += 1;
      } catch (error) {
        const deliveryError = classifyUnknownDeliveryError(error);
        const exhausted = attempt >= maximumAttempts;
        await this.completeDelivery({
          attemptId: claim.attemptId,
          completedAt: this.now().toISOString(),
          event,
          failureCode: deliveryError.code,
          lockToken: claim.lockToken,
          responseStatus: deliveryError.responseStatus,
          status: deliveryError.retryable
            ? exhausted
              ? 'dead_letter'
              : 'transient_failure'
            : 'permanent_failure',
          subscription,
        });

        if (deliveryError instanceof TransientWebhookDeliveryError) {
          transientFailures.push(deliveryError);
        } else {
          summary.permanentlyFailed += 1;
        }
      }
    }

    if (transientFailures.length > 0) {
      throw new TransientWebhookDeliveryError(
        'TRANSIENT_DELIVERIES_FAILED',
        `${transientFailures.length} webhook delivery or deliveries failed transiently`,
      );
    }

    return summary;
  }

  private async deliverToSubscription(
    event: WebhookEventEnvelope,
    subscription: WebhookSubscription,
    rawBody: string,
    attemptedAt: string,
  ): Promise<number> {
    normalizeWebhookEndpointUrl(subscription.endpointUrl, {
      allowInsecureLocalEndpoints: this.allowInsecureHttp,
    });

    const secretBytes = Buffer.byteLength(subscription.secret, 'utf8');
    if (secretBytes < 32 || secretBytes > 512) {
      throw new PermanentWebhookDeliveryError(
        'INVALID_SUBSCRIPTION',
        'Webhook subscription has an invalid signing secret',
      );
    }

    const timestamp = String(Math.floor(Date.parse(attemptedAt) / 1_000));
    const response = await this.transport.post({
      body: rawBody,
      headers: createWebhookHeaders({
        eventId: event.eventId,
        eventType: event.type,
        rawBody,
        secret: subscription.secret,
        timestamp,
      }),
      timeoutMs: this.requestTimeoutMs,
      url: subscription.endpointUrl,
    });

    assertSuccessfulResponse(response.statusCode);
    return response.statusCode;
  }

  private async completeDelivery(input: {
    readonly attemptId: string;
    readonly completedAt: string;
    readonly event: WebhookEventEnvelope;
    readonly failureCode?: string;
    readonly lockToken: string;
    readonly responseStatus?: number;
    readonly status: 'dead_letter' | 'delivered' | 'permanent_failure' | 'transient_failure';
    readonly subscription: WebhookSubscription;
  }): Promise<void> {
    await this.callRepository(() =>
      this.repository.completeDelivery({
        attemptId: input.attemptId,
        completedAt: input.completedAt,
        eventId: input.event.eventId,
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
        lockToken: input.lockToken,
        organizationId: input.event.organizationId,
        ...(input.responseStatus === undefined ? {} : { responseStatus: input.responseStatus }),
        status: input.status,
        subscriptionId: input.subscription.id,
      }),
    );
  }

  private async callRepository<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isWebhookDeliveryError(error)) {
        throw error;
      }
      throw new TransientWebhookDeliveryError(
        'REPOSITORY_UNAVAILABLE',
        'Webhook delivery repository is unavailable',
        { cause: error },
      );
    }
  }
}

function classifyUnknownDeliveryError(error: unknown): WebhookDeliveryError {
  if (isWebhookDeliveryError(error)) {
    return error;
  }

  return new PermanentWebhookDeliveryError(
    'REMOTE_CLIENT_ERROR',
    'Webhook transport failed without a retry classification',
    { cause: error },
  );
}

function assertSubscriptionScope(
  event: WebhookEventEnvelope,
  subscription: WebhookSubscription,
): void {
  if (
    subscription.organizationId !== event.organizationId ||
    subscription.status !== 'active' ||
    !subscription.eventTypes.includes(event.type)
  ) {
    throw new PermanentWebhookDeliveryError(
      'INVALID_SUBSCRIPTION',
      'Webhook repository returned a subscription outside the event scope',
    );
  }
}

function assertSuccessfulResponse(statusCode: number): void {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new PermanentWebhookDeliveryError(
      'REMOTE_CLIENT_ERROR',
      'Webhook endpoint returned an invalid HTTP status',
    );
  }

  if (statusCode >= 200 && statusCode < 300) {
    return;
  }

  if (statusCode === 408) {
    throw new TransientWebhookDeliveryError('REMOTE_TIMEOUT', 'Webhook endpoint timed out', {
      responseStatus: statusCode,
    });
  }

  if (statusCode === 425 || statusCode === 429) {
    throw new TransientWebhookDeliveryError(
      'REMOTE_RATE_LIMITED',
      'Webhook endpoint requested a retry',
      { responseStatus: statusCode },
    );
  }

  if (statusCode >= 500) {
    throw new TransientWebhookDeliveryError(
      'REMOTE_SERVER_ERROR',
      'Webhook endpoint failed temporarily',
      { responseStatus: statusCode },
    );
  }

  throw new PermanentWebhookDeliveryError(
    'REMOTE_CLIENT_ERROR',
    'Webhook endpoint rejected the request permanently',
    { responseStatus: statusCode },
  );
}
