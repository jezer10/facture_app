import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRow, assertHeader, assertDate } from './format.mjs';
test('parses accents and composes address components without inventing region names', () => {
  const row = parseRow(
    '20131312955|COMPAÑÍA PERÚ|ACTIVO|HABIDO|150101|AV.|LIMA|URB.|CENTRO|123|2|3|4|A|5|',
  );
  assert.deepEqual(row, [
    '20131312955',
    'COMPAÑÍA PERÚ',
    'ACTIVO',
    'HABIDO',
    '150101',
    'AV. LIMA Nro. 123 Int. 2 Lt. 3 Dpto. 4 Mz. A Km. 5 URB. CENTRO',
  ]);
});
test('missing address stays empty, unknown schema and bad dates fail closed', () => {
  assert.equal(parseRow('20131312955|EMPRESA|ACTIVO|HABIDO|-|-|-|-|-|-|-|-|-|-|-|')[5], '');
  assert.throws(() => parseRow('20131312955|EMPRESA'));
  assert.throws(() => assertHeader('RUC|OTRO FORMATO'));
  assert.throws(() => assertDate('2026-02-30'));
  assert.doesNotThrow(() => assertDate('2026-09-25'));
});
