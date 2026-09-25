import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return serialize(normalize(value, '$', new WeakSet()));
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function snapshotHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function normalize(value: unknown, path: string, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite canonical value at ${path}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return withAncestor(value, path, ancestors, () =>
      Array.from(value, (item, index) => normalize(item, `${path}[${index}]`, ancestors)),
    );
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported canonical value at ${path}`);
  }
  const prototype: object | null = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Canonical value at ${path} must be a plain object`);
  }
  return withAncestor(value, path, ancestors, () => {
    const output = Object.create(null) as Record<string, unknown>;
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) {
        throw new TypeError(`Undefined canonical value at ${path}.${key}`);
      }
      output[key] = normalize(source[key], `${path}.${key}`, ancestors);
    }
    return output;
  });
}

function withAncestor<T>(
  value: object,
  path: string,
  ancestors: WeakSet<object>,
  read: () => T,
): T {
  if (ancestors.has(value)) {
    throw new TypeError(`Cyclic canonical value at ${path}`);
  }
  ancestors.add(value);
  try {
    return read();
  } finally {
    ancestors.delete(value);
  }
}

function serialize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
    .join(',')}}`;
}
