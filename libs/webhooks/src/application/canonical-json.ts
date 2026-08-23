import { PermanentWebhookDeliveryError } from '../domain/webhook.errors';
import { compareCanonicalJsonKeys } from '@app/contracts';

export function canonicalJsonStringify(value: unknown): string {
  return serializeJsonValue(value, new WeakSet<object>());
}

function serializeJsonValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw invalidJson('Webhook JSON cannot contain non-finite numbers');
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'object':
      return serializeObject(value, ancestors);
    default:
      throw invalidJson('Webhook payload contains a non-JSON value');
  }
}

function serializeObject(value: object, ancestors: WeakSet<object>): string {
  if (ancestors.has(value)) {
    throw invalidJson('Webhook payload cannot contain circular references');
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value.map((item: unknown) => serializeJsonValue(item, ancestors)).join(',')}]`;
    }

    if (!isPlainObject(value)) {
      throw invalidJson('Webhook payload must contain only plain JSON objects');
    }

    const record = value as Readonly<Record<string, unknown>>;
    const properties = Object.keys(record)
      .sort(compareCanonicalJsonKeys)
      .map((key) => {
        const property = record[key];
        if (property === undefined) {
          throw invalidJson('Webhook JSON cannot contain undefined properties');
        }
        return `${JSON.stringify(key)}:${serializeJsonValue(property, ancestors)}`;
      });

    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}

function invalidJson(message: string): PermanentWebhookDeliveryError {
  return new PermanentWebhookDeliveryError('INVALID_EVENT', message);
}
