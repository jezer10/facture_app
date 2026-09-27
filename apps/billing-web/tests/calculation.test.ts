import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculate } from '../src/features/invoices/calculation.ts';
const line = {
  key: 'item',
  description: 'Servicio',
  quantity: '1',
  unitValue: '100',
  taxAffectation: 'taxed' as const,
};
test('calculates mixed taxed and exempt amounts without floating-point drift', () => {
  assert.deepEqual(
    calculate([line, { ...line, quantity: '3', unitValue: '0.10', taxAffectation: 'exonerated' }]),
    { subtotal: '100.30', tax: '18.00', total: '118.30', items: ['118.00', '0.30'] },
  );
});
test('rounds each line and its IGV to cents', () => {
  assert.equal(
    calculate([
      { ...line, unitValue: '0.03' },
      { ...line, unitValue: '0.03' },
    ]).tax,
    '0.02',
  );
});
test('tolerates incomplete and invalid form values', () => {
  assert.equal(
    calculate([
      { ...line, unitValue: '' },
      { ...line, quantity: 'not-a-number' },
      { ...line, unitValue: '-4' },
    ]).total,
    '0.00',
  );
});
