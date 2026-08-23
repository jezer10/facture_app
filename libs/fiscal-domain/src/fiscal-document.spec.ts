import {
  calculateFiscalDocument,
  FiscalValidationError,
  validateFiscalDocument,
} from './fiscal-document';
import type { FiscalDocumentInput } from './fiscal-document';

function validInvoice(overrides: Partial<FiscalDocumentInput> = {}): FiscalDocumentInput {
  return {
    documentType: '01',
    currency: 'PEN',
    issueDate: '2026-08-22',
    lines: [
      {
        lineId: '1',
        description: 'Servicio mensual',
        quantity: '1',
        unitValue: '100',
        taxCategory: 'TAXED',
      },
    ],
    ...overrides,
  };
}

describe('calculateFiscalDocument', () => {
  it('calculates mixed operations with deterministic line-level rounding', () => {
    const result = calculateFiscalDocument(
      validInvoice({
        lines: [
          {
            lineId: '1',
            description: 'Gravado',
            quantity: '2',
            unitValue: '10',
            taxCategory: 'TAXED',
          },
          {
            lineId: '2',
            description: 'Exonerado',
            quantity: '1',
            unitValue: '5.555',
            taxCategory: 'EXONERATED',
          },
          {
            lineId: '3',
            description: 'Inafecto',
            quantity: '3',
            unitValue: '2.335',
            taxCategory: 'UNAFFECTED',
          },
          {
            lineId: '4',
            description: 'Muestra gratuita gravada',
            quantity: '2',
            referenceUnitValue: '4.5',
            taxCategory: 'FREE',
            freeTaxTreatment: 'TAXED',
          },
        ],
      }),
    );

    expect(result.totals.taxableAmount.toString()).toBe('20.00');
    expect(result.totals.exoneratedAmount.toString()).toBe('5.56');
    expect(result.totals.unaffectedAmount.toString()).toBe('7.01');
    expect(result.totals.freeAmount.toString()).toBe('9.00');
    expect(result.totals.igvAmount.toString()).toBe('3.60');
    expect(result.totals.freeIgvAmount.toString()).toBe('1.62');
    expect(result.totals.payableAmount.toString()).toBe('36.17');
  });

  it('records the effective IGV rate and allows an explicit rate', () => {
    const defaultRate = calculateFiscalDocument(validInvoice());
    const explicitRate = calculateFiscalDocument(
      validInvoice({
        lines: [
          {
            lineId: '1',
            description: 'Operación con tasa explícita',
            quantity: '1',
            unitValue: '100',
            taxCategory: 'TAXED',
            igvRate: '0.10',
          },
        ],
      }),
    );

    expect(defaultRate.lines[0]?.igvRate).toBe('0.18');
    expect(explicitRate.lines[0]?.igvRate).toBe('0.1');
    expect(explicitRate.totals.payableAmount.toString()).toBe('110.00');
  });

  it('does not make a free operation payable', () => {
    const result = calculateFiscalDocument(
      validInvoice({
        lines: [
          {
            lineId: '1',
            description: 'Bonificación exonerada',
            quantity: '1',
            referenceUnitValue: '25',
            taxCategory: 'FREE',
            freeTaxTreatment: 'EXONERATED',
          },
        ],
      }),
    );

    expect(result.lines[0]?.freeAmount.toString()).toBe('25.00');
    expect(result.lines[0]?.freeIgvAmount.toString()).toBe('0.00');
    expect(result.totals.payableAmount.toString()).toBe('0.00');
  });

  it('returns immutable calculated structures', () => {
    const result = calculateFiscalDocument(validInvoice());

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lines)).toBe(true);
    expect(Object.isFrozen(result.lines[0])).toBe(true);
    expect(Object.isFrozen(result.totals)).toBe(true);
  });
});

describe('validateFiscalDocument', () => {
  it.each(['07', '08'] as const)(
    'requires an original document reference for note type %s',
    (documentType) => {
      const issues = validateFiscalDocument(validInvoice({ documentType }));

      expect(issues).toContainEqual(expect.objectContaining({ code: 'NOTE_REFERENCE_REQUIRED' }));
    },
  );

  it.each(['07', '08'] as const)(
    'accepts a complete reference for note type %s',
    (documentType) => {
      const issues = validateFiscalDocument(
        validInvoice({
          documentType,
          noteReference: {
            document: {
              documentType: '01',
              series: 'F001',
              number: '123',
            },
            reasonCode: '01',
            reason: 'Anulación de la operación',
          },
        }),
      );

      expect(issues).toEqual([]);
    },
  );

  it('rejects a note reference on invoice and receipt documents', () => {
    const issues = validateFiscalDocument(
      validInvoice({
        noteReference: {
          document: { documentType: '01', series: 'F001', number: '123' },
          reasonCode: '01',
          reason: 'No corresponde',
        },
      }),
    );

    expect(issues).toContainEqual(expect.objectContaining({ code: 'NOTE_REFERENCE_NOT_ALLOWED' }));
  });

  it('reports invalid date, duplicate lines and invalid decimal values together', () => {
    const issues = validateFiscalDocument(
      validInvoice({
        issueDate: '2026-02-30',
        lines: [
          {
            lineId: 'same',
            description: 'First',
            quantity: '0',
            unitValue: '-1',
            taxCategory: 'TAXED',
            igvRate: '1.1',
          },
          {
            lineId: 'same',
            description: 'Second',
            quantity: '1',
            unitValue: '1',
            taxCategory: 'UNAFFECTED',
          },
        ],
      }),
    );

    expect(issues.map(({ code }) => code)).toEqual([
      'INVALID_ISSUE_DATE',
      'INVALID_QUANTITY',
      'INVALID_UNIT_VALUE',
      'INVALID_IGV_RATE',
      'DUPLICATE_LINE_ID',
    ]);
  });

  it('rejects IGV on a free exonerated or unaffected operation', () => {
    const issues = validateFiscalDocument(
      validInvoice({
        lines: [
          {
            lineId: '1',
            description: 'Regalo exonerado',
            quantity: '1',
            referenceUnitValue: '10',
            taxCategory: 'FREE',
            freeTaxTreatment: 'EXONERATED',
            igvRate: '0.18',
          },
        ],
      }),
    );

    expect(issues).toContainEqual(expect.objectContaining({ code: 'INVALID_IGV_RATE' }));
  });

  it('normalizes identifiers before producing the calculated document', () => {
    const result = calculateFiscalDocument(
      validInvoice({
        documentType: '07',
        lines: [
          {
            lineId: ' 1 ',
            description: ' Ajuste ',
            quantity: '1',
            unitValue: '10',
            taxCategory: 'TAXED',
          },
        ],
        noteReference: {
          document: { documentType: '01', series: ' F001 ', number: ' 42 ' },
          reasonCode: ' 01 ',
          reason: ' Ajuste de monto ',
        },
      }),
    );

    expect(result.lines[0]?.lineId).toBe('1');
    expect(result.lines[0]?.description).toBe('Ajuste');
    expect(result.noteReference).toEqual({
      document: { documentType: '01', series: 'F001', number: '42' },
      reasonCode: '01',
      reason: 'Ajuste de monto',
    });
  });

  it('throws a validation error before calculating invalid documents', () => {
    expect(() => calculateFiscalDocument(validInvoice({ lines: [] }))).toThrow(
      FiscalValidationError,
    );
  });
});
