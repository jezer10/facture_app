export const SUPPORTED_FISCAL_DOCUMENT_TYPES = ['01', '03', '07', '08'] as const;

export type FiscalDocumentType = (typeof SUPPORTED_FISCAL_DOCUMENT_TYPES)[number];

export interface FiscalPartySnapshot {
  documentType: string;
  documentNumber: string;
  legalName: string;
}

export interface FiscalTaxSnapshot {
  schemeId: string;
  schemeName: string;
  taxAmount: string;
  taxableAmount: string;
}

export interface FiscalLineSnapshot {
  id: string;
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
  lineExtensionAmount: string;
  tax: FiscalTaxSnapshot;
}

export interface ReferencedFiscalDocument {
  documentType: '01' | '03';
  id: string;
  reasonCode: string;
  reasonDescription: string;
}

/** Immutable fiscal snapshot resolved from Core using payloadRef. */
export interface FiscalDocumentSnapshot {
  documentId: string;
  documentType: FiscalDocumentType;
  series: string;
  number: string;
  issueDate: string;
  currencyCode: string;
  issuer: FiscalPartySnapshot;
  recipient: FiscalPartySnapshot;
  lines: FiscalLineSnapshot[];
  taxTotal: string;
  lineExtensionTotal: string;
  payableTotal: string;
  reference?: ReferencedFiscalDocument;
}

export interface ReceivedDocumentSyncRequest {
  syncId: string;
  dateFrom: string;
  dateTo: string;
  documentTypes: FiscalDocumentType[];
  source?: string;
}

export interface ReceivedDocumentDescriptor {
  sourceId: string;
  supplierRuc: string;
  documentType: FiscalDocumentType;
  series: string;
  number: string;
  issueDate: string;
  source: string;
  snapshot: Record<string, unknown>;
  snapshotSha256: string;
}

export interface FiscalDocumentIdentity {
  documentId: string;
  issuerRuc: string;
  documentType: FiscalDocumentType;
  series: string;
  number: string;
}

export function toFiscalDocumentIdentity(snapshot: FiscalDocumentSnapshot): FiscalDocumentIdentity {
  return {
    documentId: snapshot.documentId,
    issuerRuc: snapshot.issuer.documentNumber,
    documentType: snapshot.documentType,
    series: snapshot.series,
    number: snapshot.number,
  };
}
