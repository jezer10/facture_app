import { FiscalDecimal, Money } from './money';
import { createImmutableSnapshot, NonCanonicalSnapshotValueError } from './snapshot';

describe('createImmutableSnapshot', () => {
  it('sorts object keys and produces a stable SHA-256 hash', () => {
    const first = createImmutableSnapshot({ b: 2, a: 1 });
    const second = createImmutableSnapshot({ a: 1, b: 2 });

    expect(first.canonicalJson).toBe('{"a":1,"b":2}');
    expect(first.sha256).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
    expect(second.sha256).toBe(first.sha256);
  });

  it('normalizes money and decimal values before hashing', () => {
    const snapshot = createImmutableSnapshot({
      total: Money.of('12.3', 'PEN'),
      quantity: new FiscalDecimal('1.2300'),
    });

    expect(snapshot.canonicalJson).toBe(
      '{"quantity":"1.23","total":{"amount":"12.30","currency":"PEN"}}',
    );
  });

  it('deeply freezes its detached canonical data', () => {
    const original = { nested: { values: [1, 2] } };
    const snapshot = createImmutableSnapshot(original);
    const data = snapshot.data as {
      nested: { values: number[] };
    };

    original.nested.values.push(3);

    expect(data.nested.values).toEqual([1, 2]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.nested)).toBe(true);
    expect(Object.isFrozen(data.nested.values)).toBe(true);
  });

  it('rejects unsupported, undefined and cyclic values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => createImmutableSnapshot({ missing: undefined })).toThrow(
      NonCanonicalSnapshotValueError,
    );
    expect(() => createImmutableSnapshot(new Date())).toThrow(NonCanonicalSnapshotValueError);
    expect(() => createImmutableSnapshot(cyclic)).toThrow(NonCanonicalSnapshotValueError);
  });

  it('rejects values that canonical JSON cannot represent unambiguously', () => {
    const sparse = Array<number>(2);
    sparse[1] = 2;
    const symbolKeyed = { visible: true } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol('hidden')] = true;

    expect(() => createImmutableSnapshot(sparse)).toThrow(NonCanonicalSnapshotValueError);
    expect(() => createImmutableSnapshot(symbolKeyed)).toThrow(NonCanonicalSnapshotValueError);
  });
});
