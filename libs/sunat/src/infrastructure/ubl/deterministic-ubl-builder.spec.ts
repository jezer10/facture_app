import { parseFiscalDocumentSnapshot } from '../../application/parse-sunat-payload';
import { fiscalDocumentFixture } from '../../testing/sunat-test-fixtures';
import { DeterministicUblBuilder } from './deterministic-ubl-builder';

describe('DeterministicUblBuilder', () => {
  const builder = new DeterministicUblBuilder();

  it('builds deterministic UBL 2.1 and escapes user-controlled XML text', () => {
    const snapshot = parseFiscalDocumentSnapshot(fiscalDocumentFixture());
    const first = builder.build(snapshot);
    const second = builder.build(snapshot);

    expect(second).toEqual(first);
    expect(first.sha256).toHaveLength(64);
    expect(first.xml).toContain('<cbc:UBLVersionID>2.1</cbc:UBLVersionID>');
    expect(first.xml).toContain('Servicios &amp; Pruebas SAC');
    expect(first.xml).toContain('Cliente &lt;Demo&gt; SAC');
    expect(first.xml).not.toContain('Cliente <Demo>');
  });

  it.each([
    ['01', 'Invoice', 'InvoiceLine'],
    ['03', 'Invoice', 'InvoiceLine'],
    ['07', 'CreditNote', 'CreditNoteLine'],
    ['08', 'DebitNote', 'DebitNoteLine'],
  ] as const)('uses the UBL root and line for document type %s', (type, root, line) => {
    const isNote = type === '07' || type === '08';
    const snapshot = parseFiscalDocumentSnapshot(
      fiscalDocumentFixture({
        documentType: type,
        ...(isNote
          ? {
              reference: {
                documentType: '01',
                id: 'F001-1',
                reasonCode: '01',
                reasonDescription: 'Anulación',
              },
            }
          : {}),
      }),
    );

    const result = builder.build(snapshot);

    expect(result.xml).toContain(`<${root} xmlns=`);
    expect(result.xml).toContain(`<cac:${line}>`);
    if (isNote) {
      expect(result.xml).toContain('<cac:DiscrepancyResponse>');
      expect(result.xml).toContain('<cbc:ReferenceID>F001-1</cbc:ReferenceID>');
    }
  });
});
