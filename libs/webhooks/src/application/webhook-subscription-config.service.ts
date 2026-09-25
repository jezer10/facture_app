import type { WebhookRepository } from '../domain/webhook-repository';
import { normalizeWebhookEndpointUrl } from '../domain/webhook-endpoint';
import type {
  ConfigureWebhookSubscriptionInput,
  WebhookSubscription,
  WebhookSubscriptionView,
} from '../domain/webhook-subscription';
import { toWebhookSubscriptionView } from '../domain/webhook-subscription';
import { PermanentWebhookDeliveryError } from '../domain/webhook.errors';
import { assertEventType, assertOrganizationId, assertSubscriptionId } from './webhook-validation';

export interface WebhookSubscriptionConfigurationOptions {
  readonly allowInsecureHttp: boolean;
  readonly now?: () => Date;
}

export class WebhookSubscriptionConfigurationService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: WebhookRepository,
    private readonly options: WebhookSubscriptionConfigurationOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async list(organizationId: string): Promise<readonly WebhookSubscriptionView[]> {
    const normalizedOrganizationId = assertOrganizationId(organizationId);
    const subscriptions = await this.repository.listSubscriptions(normalizedOrganizationId);
    return subscriptions.map(toWebhookSubscriptionView);
  }

  async configure(
    organizationId: string,
    subscriptionId: string,
    untrustedInput: unknown,
  ): Promise<WebhookSubscriptionView> {
    const normalizedOrganizationId = assertOrganizationId(organizationId);
    const normalizedSubscriptionId = assertSubscriptionId(subscriptionId);
    const input = parseConfigurationInput(untrustedInput);
    const endpointUrl = normalizeWebhookEndpointUrl(input.endpointUrl, {
      allowInsecureLocalEndpoints: this.options.allowInsecureHttp,
    });
    const eventTypes = normalizeEventTypes(input.eventTypes);
    const existing = await this.repository.findSubscription(
      normalizedOrganizationId,
      normalizedSubscriptionId,
    );
    const secret = resolveSecret(input.secret, existing);
    const timestamp = this.now().toISOString();

    const subscription: WebhookSubscription = {
      createdAt: existing?.createdAt ?? timestamp,
      endpointUrl,
      eventTypes,
      id: normalizedSubscriptionId,
      organizationId: normalizedOrganizationId,
      secret,
      status: input.enabled ? 'active' : 'disabled',
      updatedAt: timestamp,
    };

    const saved = await this.repository.saveSubscription(subscription, {
      secretWasProvided: input.secret !== undefined,
    });
    return toWebhookSubscriptionView(saved);
  }
}

function parseConfigurationInput(value: unknown): ConfigureWebhookSubscriptionInput {
  if (!isRecord(value)) {
    throw invalidSubscription('Request body must be an object');
  }

  const allowedKeys = new Set(['enabled', 'endpointUrl', 'eventTypes', 'secret']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw invalidSubscription('Request body contains unsupported fields');
  }

  if (typeof value.endpointUrl !== 'string') {
    throw invalidSubscription('endpointUrl must be a string');
  }
  if (typeof value.enabled !== 'boolean') {
    throw invalidSubscription('enabled must be a boolean');
  }
  if (
    !Array.isArray(value.eventTypes) ||
    !value.eventTypes.every((item) => typeof item === 'string')
  ) {
    throw invalidSubscription('eventTypes must be an array of strings');
  }
  if (value.secret !== undefined && typeof value.secret !== 'string') {
    throw invalidSubscription('secret must be a string when provided');
  }

  return {
    enabled: value.enabled,
    endpointUrl: value.endpointUrl,
    eventTypes: value.eventTypes,
    ...(value.secret === undefined ? {} : { secret: value.secret }),
  };
}

function normalizeEventTypes(eventTypes: readonly string[]): readonly string[] {
  if (eventTypes.length === 0 || eventTypes.length > 100) {
    throw invalidSubscription('eventTypes must contain between 1 and 100 values');
  }

  const normalized = eventTypes.map(assertEventType);
  return [...new Set(normalized)].sort();
}

function resolveSecret(
  candidate: string | undefined,
  existing: WebhookSubscription | undefined,
): string {
  if (candidate === undefined) {
    if (existing === undefined) {
      throw invalidSubscription('secret is required for a new subscription');
    }
    return existing.secret;
  }

  const secretBytes = Buffer.byteLength(candidate, 'utf8');
  if (secretBytes < 32 || secretBytes > 512) {
    throw invalidSubscription('secret must contain between 32 and 512 UTF-8 bytes');
  }

  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidSubscription(message: string): PermanentWebhookDeliveryError {
  return new PermanentWebhookDeliveryError('INVALID_SUBSCRIPTION', message);
}
