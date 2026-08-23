import Decimal from 'decimal.js';

export type DecimalValue = Decimal.Value;

export const FiscalDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

export const MONEY_SCALE = 2;

export class InvalidDecimalError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
  ) {
    super(`${field} must be a finite decimal`);
    this.name = 'InvalidDecimalError';
  }
}

export function parseDecimal(value: unknown, field = 'value'): Decimal {
  try {
    const decimal = new FiscalDecimal(value as DecimalValue);
    if (!decimal.isFinite()) {
      throw new InvalidDecimalError(field, value);
    }
    return decimal;
  } catch (error) {
    if (error instanceof InvalidDecimalError) {
      throw error;
    }
    throw new InvalidDecimalError(field, value);
  }
}

export function canonicalDecimal(value: DecimalValue): string {
  const decimal = parseDecimal(value);
  return decimal.isZero() ? '0' : decimal.toFixed();
}

function assertCurrencyCode(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Invalid ISO 4217 currency code: ${currency}`);
  }
}

export class Money {
  private constructor(
    private readonly decimalAmount: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static of(amount: DecimalValue, currency: string): Money {
    assertCurrencyCode(currency);
    return new Money(
      parseDecimal(amount, 'amount').toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP),
      currency,
    );
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.decimalAmount.plus(other.decimalAmount), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.decimalAmount.minus(other.decimalAmount), this.currency);
  }

  isZero(): boolean {
    return this.decimalAmount.isZero();
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.decimalAmount.equals(other.decimalAmount);
  }

  toDecimal(): Decimal {
    return new FiscalDecimal(this.decimalAmount);
  }

  toString(): string {
    return this.decimalAmount.toFixed(MONEY_SCALE);
  }

  toJSON(): Readonly<{ amount: string; currency: string }> {
    return Object.freeze({ amount: this.toString(), currency: this.currency });
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Cannot combine ${this.currency} and ${other.currency} monetary values`);
    }
  }
}
