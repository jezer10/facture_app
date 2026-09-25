import { SunatValidationError } from '../domain/errors/sunat.error';
import { fiscalDocumentFixture } from '../testing/sunat-test-fixtures';
import {
  parseFiscalDocumentSnapshot,
  parseReceivedDocumentSyncRequest,
} from './parse-sunat-payload';

describe('SUNAT payload parsing', () => {
  it('normalizes a valid immutable fiscal snapshot', () => {
    const result = parseFiscalDocumentSnapshot(fiscalDocumentFixture());

    expect(result.documentType).toBe('01');
    expect(result.issuer.documentNumber).toBe('20123456789');
    expect(result.lines[0]?.tax.taxAmount).toBe('18.00');
  });

  it('adapts the immutable snapshot shape emitted by fiscal-core without losing the bigint number', () => {
    const result = parseFiscalDocumentSnapshot(
      {
        currency: 'PEN',
        customer: {
          identityType: '6',
          identityNumber: '20987654321',
          legalName: 'Cliente SAC',
        },
        documentType: '01',
        issueDate: '2026-08-22',
        issuer: { ruc: '20123456789', legalName: 'Emisor SAC' },
        lines: [
          {
            lineId: '1',
            description: 'Servicio',
            quantity: '1',
            unitCode: 'NIU',
            netUnitValue: '100.00',
            taxAffectation: 'taxed',
            taxableAmount: '100.00',
            igvAmount: '18.00',
          },
        ],
        number: '9007199254740993',
        series: 'F001',
        totals: { igvAmount: '18.00', payableAmount: '118.00' },
      },
      { documentId: 'document-1' },
    );

    expect(result).toEqual(
      expect.objectContaining({
        documentId: 'document-1',
        number: '9007199254740993',
        currencyCode: 'PEN',
        lineExtensionTotal: '100.00',
      }),
    );
  });

  it('requires a reference for notes and rejects impossible dates', () => {
    expect(() =>
      parseFiscalDocumentSnapshot(
        fiscalDocumentFixture({ documentType: '07', issueDate: '2026-02-30' }),
      ),
    ).toThrow(SunatValidationError);
  });

  it('limits received-document synchronization to 15 inclusive days', () => {
    expect(() =>
      parseReceivedDocumentSyncRequest({
        syncId: 'sync-1',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-16',
        documentTypes: ['01'],
      }),
    ).toThrow('entre 1 y 15 días');

    expect(
      parseReceivedDocumentSyncRequest({
        syncId: 'sync-1',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-15',
        documentTypes: ['01', '01', '03'],
      }).documentTypes,
    ).toEqual(['01', '03']);
  });
});
