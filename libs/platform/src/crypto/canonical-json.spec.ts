import { canonicalJson } from './canonical-json';

describe('canonicalJson', () => {
  it('sorts keys recursively without reordering arrays', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, lines: [{ z: 1, a: 2 }] })).toBe(
      '{"a":{"b":3,"y":2},"lines":[{"a":2,"z":1}],"z":1}',
    );
  });

  it('uses locale-independent UTF-16 ordering for case-distinct keys', () => {
    expect(canonicalJson({ a: 'lower', A: 'upper' })).toBe('{"A":"upper","a":"lower"}');
  });

  it('rejects values JSON cannot preserve', () => {
    expect(() => canonicalJson({ total: Number.NaN })).toThrow(/non-finite/u);
  });
});
