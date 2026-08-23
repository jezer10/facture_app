import { createHash } from 'node:crypto';

import Decimal from 'decimal.js';
import { compareCanonicalJsonKeys } from '@app/contracts';

import { Money } from './money';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface ImmutableSnapshot {
  readonly data: CanonicalJsonValue;
  readonly canonicalJson: string;
  readonly sha256: string;
}

export class NonCanonicalSnapshotValueError extends Error {
  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`Snapshot value at ${path} ${reason}`);
    this.name = 'NonCanonicalSnapshotValueError';
  }
}

export function createImmutableSnapshot(value: unknown): ImmutableSnapshot {
  const data = freezeCanonicalValue(toCanonicalValue(value, '$', new WeakSet()));
  const canonicalJson = serializeCanonicalJson(data);
  const sha256 = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');

  return Object.freeze({ data, canonicalJson, sha256 });
}

export function serializeCanonicalJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new NonCanonicalSnapshotValueError('$', 'must be finite');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(',')}]`;
  }

  const record = value as Readonly<Record<string, CanonicalJsonValue>>;
  return `{${Object.keys(record)
    .sort(compareCanonicalJsonKeys)
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(record[key]!)}`)
    .join(',')}}`;
}

function toCanonicalValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new NonCanonicalSnapshotValueError(path, 'must be finite');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Money) {
    return toCanonicalValue(value.toJSON(), path, ancestors);
  }
  if (Decimal.isDecimal(value)) {
    return value.isZero() ? '0' : value.toFixed();
  }
  if (Array.isArray(value)) {
    return withAncestor(value, path, ancestors, () => {
      assertDenseArray(value, path);
      return Array.from(value, (item, index) =>
        toCanonicalValue(item, `${path}[${index}]`, ancestors),
      );
    });
  }
  if (typeof value !== 'object') {
    throw new NonCanonicalSnapshotValueError(path, `has unsupported type ${typeof value}`);
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NonCanonicalSnapshotValueError(path, 'must be a plain object');
  }

  return withAncestor(value, path, ancestors, () => {
    const source = value as Record<string, unknown>;
    const canonical = Object.create(null) as Record<string, CanonicalJsonValue>;
    const keys = canonicalObjectKeys(source, path);
    for (const key of keys) {
      canonical[key] = toCanonicalValue(source[key], `${path}.${key}`, ancestors);
    }
    return canonical;
  });
}

function canonicalObjectKeys(source: object, path: string): string[] {
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new NonCanonicalSnapshotValueError(path, 'must not contain symbol keys');
  }

  return (keys as string[]).sort(compareCanonicalJsonKeys).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new NonCanonicalSnapshotValueError(
        `${path}.${key}`,
        'must be an enumerable data property',
      );
    }
    return key;
  });
}

function assertDenseArray(value: readonly unknown[], path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new NonCanonicalSnapshotValueError(path, 'must not contain sparse entries');
    }
  }
}

function withAncestor<T>(
  value: object,
  path: string,
  ancestors: WeakSet<object>,
  readValue: () => T,
): T {
  if (ancestors.has(value)) {
    throw new NonCanonicalSnapshotValueError(path, 'must not be cyclic');
  }
  ancestors.add(value);
  try {
    return readValue();
  } finally {
    ancestors.delete(value);
  }
}

function freezeCanonicalValue(value: CanonicalJsonValue): CanonicalJsonValue {
  if (Array.isArray(value)) {
    const arrayValue = value as CanonicalJsonValue[];
    arrayValue.forEach(freezeCanonicalValue);
    return Object.freeze(arrayValue);
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeCanonicalValue);
    return Object.freeze(value);
  }
  return value;
}
