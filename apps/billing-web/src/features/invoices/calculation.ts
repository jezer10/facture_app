import Decimal from 'decimal.js';
export interface DraftLine {
  key: string;
  description: string;
  quantity: string;
  unitValue: string;
  taxAffectation: 'taxed' | 'exonerated' | 'unaffected';
}
export function newLine(): DraftLine {
  return {
    key: crypto.randomUUID(),
    description: '',
    quantity: '1',
    unitValue: '',
    taxAffectation: 'taxed',
  };
}
export function calculate(lines: readonly DraftLine[]) {
  let subtotal = new Decimal(0);
  let tax = new Decimal(0);
  const items = lines.map((line) => {
    try {
      const quantity = new Decimal(line.quantity || '0');
      const value = new Decimal(line.unitValue || '0');
      if (!quantity.isFinite() || !value.isFinite() || quantity.isNegative() || value.isNegative())
        throw new Error('invalid');
      const base = quantity.mul(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const igv =
        line.taxAffectation === 'taxed'
          ? base.mul('0.18').toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          : new Decimal(0);
      subtotal = subtotal.plus(base);
      tax = tax.plus(igv);
      return base.plus(igv).toFixed(2);
    } catch {
      return '0.00';
    }
  });
  return {
    subtotal: subtotal.toFixed(2),
    tax: tax.toFixed(2),
    total: subtotal.plus(tax).toFixed(2),
    items,
  };
}
