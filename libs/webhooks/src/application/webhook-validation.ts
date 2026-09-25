import type { WebhookEventEnvelope, WebhookEventType } from '@app/contracts';

import type { JsonValue } from '../domain/json-value';
import { PermanentWebhookDeliveryError } from '../domain/webhook.errors';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const EVENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEBHOOK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'fiscal-document.processing.v1',
  'fiscal-document.accepted.v1',
  'fiscal-document.rejected.v1',
  'fiscal-document.failed.v1',
  'fiscal-document.voided.v1',
  'received-document.imported.v1',
]);
type FiscalWebhookEventType = Exclude<WebhookEventType, 'received-document.imported.v1'>;
const FISCAL_STATUSES_BY_EVENT: Readonly<Record<FiscalWebhookEventType, ReadonlySet<string>>> = {
  'fiscal-document.processing.v1': new Set(['processing']),
  'fiscal-document.accepted.v1': new Set(['accepted', 'accepted_with_observations']),
  'fiscal-document.rejected.v1': new Set(['rejected']),
  'fiscal-document.failed.v1': new Set(['failed']),
  'fiscal-document.voided.v1': new Set(['voided']),
};

export function parseWebhookEventEnvelope(value: unknown): WebhookEventEnvelope {
  if (!isRecord(value)) {
    throw invalidEvent('Webhook job data must be an object');
  }
  assertAllowedKeys(value, [
    'causationId',
    'correlationId',
    'eventId',
    'issuerId',
    'occurredAt',
    'organizationId',
    'payload',
    'payloadRef',
    'payloadSha256',
    'type',
    'version',
  ]);

  const eventId = parseIdentifier(value.eventId, 'eventId');
  const organizationId = parseUuid(value.organizationId, 'organizationId');
  const issuerId = parseUuid(value.issuerId, 'issuerId');
  const correlationId = parseIdentifier(value.correlationId, 'correlationId');
  const type = parseEventType(value.type);
  const occurredAt = parseIsoDate(value.occurredAt);
  if (value.version !== 1) {
    throw invalidEvent('version must be 1');
  }
  const payloadRef = parseNonEmptyString(value.payloadRef, 'payloadRef', 2_048);
  const payloadSha256 = parseSha256(value.payloadSha256);
  const payload = parseWebhookPayload(value.payload);
  assertEventPayloadCompatibility(type, payload);
  const causationId =
    value.causationId === undefined ? undefined : parseIdentifier(value.causationId, 'causationId');

  return {
    ...(causationId === undefined ? {} : { causationId }),
    correlationId,
    eventId,
    issuerId,
    occurredAt,
    organizationId,
    payload,
    payloadRef,
    payloadSha256,
    type,
    version: 1,
  };
}

function assertEventPayloadCompatibility(
  eventType: WebhookEventType,
  payload: WebhookEventEnvelope['payload'],
): void {
  if (eventType === 'received-document.imported.v1') {
    if (payload.resourceType !== 'received-document' || payload.publicStatus !== 'imported') {
      throw invalidEvent('received-document.imported.v1 requires an imported received document');
    }
    return;
  }

  if (
    payload.resourceType !== 'fiscal-document' ||
    !FISCAL_STATUSES_BY_EVENT[eventType].has(payload.publicStatus)
  ) {
    throw invalidEvent(`${eventType} requires its matching fiscal-document status`);
  }
}

export function assertOrganizationId(value: string): string {
  return parseUuid(value, 'organizationId');
}

export function assertEventId(value: string): string {
  return parseIdentifier(value, 'eventId');
}

export function assertSubscriptionId(value: string): string {
  return parseUuid(value, 'subscriptionId');
}

export function assertEventType(value: string): string {
  return parseEventType(value);
}

function parseIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw invalidEvent(`${field} has an invalid format`);
  }
  return value;
}

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidEvent(`${field} must be a UUID`);
  }
  return value;
}

function parseEventType(value: unknown): WebhookEventType {
  if (
    typeof value !== 'string' ||
    !EVENT_TYPE_PATTERN.test(value) ||
    !WEBHOOK_EVENT_TYPES.has(value)
  ) {
    throw invalidEvent('eventType has an invalid format');
  }
  return value as WebhookEventType;
}

function parseIsoDate(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidEvent('occurredAt must be an ISO-8601 timestamp');
  }

  const parsedTimestamp = Date.parse(value);
  if (!Number.isFinite(parsedTimestamp) || new Date(parsedTimestamp).toISOString() !== value) {
    throw invalidEvent('occurredAt must be a normalized ISO-8601 timestamp');
  }

  return value;
}

function parseWebhookPayload(value: unknown): WebhookEventEnvelope['payload'] {
  if (!isRecord(value)) {
    throw invalidEvent('payload must be a JSON object');
  }
  assertAllowedKeys(value, ['dataUrl', 'publicStatus', 'resourceId', 'resourceType']);

  assertJsonValue(value, new WeakSet<object>());
  const resourceId = parseUuid(value.resourceId, 'payload.resourceId');
  if (value.resourceType !== 'fiscal-document' && value.resourceType !== 'received-document') {
    throw invalidEvent('payload.resourceType has an invalid value');
  }
  const publicStatus = parseNonEmptyString(value.publicStatus, 'payload.publicStatus', 200);
  const dataUrl = parseAbsoluteHttpUrl(value.dataUrl, 'payload.dataUrl');

  return {
    dataUrl,
    publicStatus,
    resourceId,
    resourceType: value.resourceType,
  };
}

function parseNonEmptyString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw invalidEvent(`${field} has an invalid format`);
  }
  return value;
}

function assertAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidEvent('Webhook event contains unsupported fields');
  }
}

function parseSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw invalidEvent('payloadSha256 must be a SHA-256 hex digest');
  }
  return value;
}

function parseAbsoluteHttpUrl(value: unknown, field: string): string {
  const parsed = parseNonEmptyString(value, field, 8_192);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw invalidEvent(`${field} must be an absolute HTTP URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidEvent(`${field} must be an absolute HTTP URL`);
  }
  return parsed;
}

function assertJsonValue(value: unknown, ancestors: WeakSet<object>): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalidEvent('payload contains a non-finite number');
    }
    return;
  }

  if (typeof value !== 'object') {
    throw invalidEvent('payload contains a non-JSON value');
  }

  if (ancestors.has(value)) {
    throw invalidEvent('payload contains a circular reference');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item) => assertJsonValue(item, ancestors));
      return;
    }

    if (!isRecord(value)) {
      throw invalidEvent('payload contains a non-plain object');
    }

    Object.values(value).forEach((item) => assertJsonValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}

function invalidEvent(message: string): PermanentWebhookDeliveryError {
  return new PermanentWebhookDeliveryError('INVALID_EVENT', message);
}
