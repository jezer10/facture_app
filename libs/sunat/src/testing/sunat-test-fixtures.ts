import type { IssueDocumentCommandPayload, SunatCommandEnvelope } from '@app/contracts';

import type { FiscalDocumentSnapshot } from '../domain/models/fiscal-document';
import type { InMemorySunatStoreAdapter } from '../infrastructure/storage/in-memory-sunat-store.adapter';

export const TEST_NOW = new Date('2026-08-22T15:00:00.000Z');

export function fiscalDocumentFixture(
  overrides: Partial<FiscalDocumentSnapshot> = {},
): FiscalDocumentSnapshot {
  return {
    documentId: 'document-1',
    documentType: '01',
    series: 'F001',
    number: '42',
    issueDate: '2026-08-22',
    currencyCode: 'PEN',
    issuer: {
      documentType: '6',
      documentNumber: '20123456789',
      legalName: 'Servicios & Pruebas SAC',
    },
    recipient: {
      documentType: '6',
      documentNumber: '20987654321',
      legalName: 'Cliente <Demo> SAC',
    },
    lines: [
      {
        id: '1',
        description: 'Servicio mensual',
        quantity: '1',
        unitCode: 'NIU',
        unitPrice: '100.00',
        lineExtensionAmount: '100.00',
        tax: {
          schemeId: '1000',
          schemeName: 'IGV',
          taxableAmount: '100.00',
          taxAmount: '18.00',
        },
      },
    ],
    taxTotal: '18.00',
    lineExtensionTotal: '100.00',
    payableTotal: '118.00',
    ...overrides,
  };
}

export function issueCommandFixture(
  store: InMemorySunatStoreAdapter,
  snapshot = fiscalDocumentFixture(),
): Extract<SunatCommandEnvelope, { type: 'sunat.document.issue.requested.v1' }> {
  const stored = store.seedJson('memory://core/document-1', snapshot);
  const payload: IssueDocumentCommandPayload = {
    documentId: snapshot.documentId,
    documentType: snapshot.documentType,
    series: snapshot.series,
    number: snapshot.number,
  };
  return {
    eventId: 'event-issue-1',
    type: 'sunat.document.issue.requested.v1',
    version: 1,
    occurredAt: TEST_NOW.toISOString(),
    correlationId: 'correlation-1',
    organizationId: 'organization-1',
    issuerId: 'issuer-1',
    payloadRef: stored.payloadRef,
    payloadSha256: stored.sha256,
    payload,
  };
}
