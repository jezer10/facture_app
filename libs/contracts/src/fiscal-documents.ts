export const FISCAL_DOCUMENT_TYPES = ['01', '03', '07', '08'] as const;
export type FiscalDocumentType = (typeof FISCAL_DOCUMENT_TYPES)[number];

export const PUBLIC_DOCUMENT_STATUSES = [
  'queued',
  'processing',
  'accepted',
  'accepted_with_observations',
  'rejected',
  'failed',
  'void_pending',
  'voided',
] as const;
export type PublicDocumentStatus = (typeof PUBLIC_DOCUMENT_STATUSES)[number];

export type TaxAffectation = 'taxed' | 'exonerated' | 'unaffected' | 'free';

export interface FiscalPartyInput {
  readonly identityType: '0' | '1' | '4' | '6' | '7' | 'A' | 'B' | 'C' | 'D';
  readonly identityNumber: string;
  readonly legalName: string;
  readonly tradeName?: string;
  readonly email?: string;
  readonly address?: {
    readonly line: string;
    readonly district?: string;
    readonly province?: string;
    readonly department?: string;
    readonly ubigeo?: string;
    readonly countryCode?: string;
  };
}

export interface FiscalDocumentLineInput {
  readonly itemCode?: string;
  readonly description: string;
  readonly unitCode: string;
  readonly quantity: string;
  readonly unitValue: string;
  readonly taxAffectation: TaxAffectation;
  readonly taxRate: string;
  readonly freeTaxTreatment?: Exclude<TaxAffectation, 'free'>;
  readonly referenceUnitValue?: string;
  readonly discountAmount?: string;
}

export interface DocumentReferenceInput {
  readonly documentId: string;
  readonly documentType: '01' | '03';
  readonly series: string;
  readonly number: string;
  readonly reasonCode: string;
  readonly reasonDescription: string;
}

export interface CreateFiscalDocumentInput {
  readonly issuerId: string;
  readonly documentType: FiscalDocumentType;
  readonly seriesId: string;
  readonly issueDate: string;
  readonly currency: 'PEN' | 'USD';
  readonly customer: FiscalPartyInput;
  readonly lines: readonly FiscalDocumentLineInput[];
  readonly reference?: DocumentReferenceInput;
  readonly purchaseOrder?: string;
  readonly notes?: readonly string[];
}

export interface AcceptedFiscalDocument {
  readonly id: string;
  readonly documentType: FiscalDocumentType;
  readonly series: string;
  readonly number: string;
  readonly status: PublicDocumentStatus;
  readonly statusUrl: string;
}
