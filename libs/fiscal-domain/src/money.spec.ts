import { canonicalDecimal, Money } from './money';

describe('Money', () => {
  it('rounds monetary amounts half up to two decimals', () => {
    expect(Money.of('10.005', 'PEN').toString()).toBe('10.01');
    expect(Money.of('10.004', 'PEN').toString()).toBe('10.00');
  });

  it('adds and subtracts values without changing either operand', () => {
    const first = Money.of('10.20', 'PEN');
    const second = Money.of('2.15', 'PEN');

    expect(first.add(second).toString()).toBe('12.35');
    expect(first.subtract(second).toString()).toBe('8.05');
    expect(first.toString()).toBe('10.20');
  });

  it('rejects operations between different currencies', () => {
    expect(() => Money.of(1, 'PEN').add(Money.of(1, 'USD'))).toThrow('Cannot combine PEN and USD');
  });

  it('emits canonical decimals without exponent or insignificant zeros', () => {
    expect(canonicalDecimal('1.23000')).toBe('1.23');
    expect(canonicalDecimal('-0')).toBe('0');
    expect(canonicalDecimal('0.0000000000000000000001')).toBe('0.0000000000000000000001');
  });

  it('rejects invalid currency and non-finite values', () => {
    expect(() => Money.of(1, 'pen')).toThrow('Invalid ISO 4217');
    expect(() => Money.of(Number.POSITIVE_INFINITY, 'PEN')).toThrow('must be a finite decimal');
  });
});
