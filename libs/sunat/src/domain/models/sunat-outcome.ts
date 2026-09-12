import type { FiscalDocumentIdentity, ReceivedDocumentDescriptor } from './fiscal-document';

export type SunatProviderEnvironment = 'mock' | 'beta' | 'production';

export interface IssuerCredentialHandle {
  issuerId: string;
  credentialVersion: number;
  environment: SunatProviderEnvironment;
  certificateReference: string | null;
  certificateFingerprint: string | null;
  solCredentialReference: string | null;
}

export interface UnsignedUblDocument {
  identity: FiscalDocumentIdentity;
  xml: string;
  sha256: string;
}

export interface SignedUblDocument extends UnsignedUblDocument {
  signature:
    | {
        state: 'signed';
        certificateFingerprint: string;
      }
    | {
        state: 'mock_unsigned';
        certificateFingerprint: null;
      };
}

export type SunatSubmissionOutcome =
  | {
      status: 'accepted' | 'accepted_with_observations';
      providerTrackingId: string;
      responseCode: string;
      description: string;
      observations: string[];
      cdrReference: string | null;
    }
  | {
      status: 'rejected';
      providerTrackingId: string | null;
      responseCode: string;
      description: string;
      observations: string[];
      cdrReference: string | null;
    }
  | {
      status: 'pending';
      providerTrackingId: string | null;
    };

export type SunatVoidOutcome =
  | {
      status: 'voided';
      providerTrackingId: string;
      artifacts: readonly [];
    }
  | Extract<SunatSubmissionOutcome, { status: 'rejected' | 'pending' }>;

export type SunatReconciliationOutcome =
  | SunatSubmissionOutcome
  | SunatVoidOutcome
  | { status: 'not_found'; providerTrackingId: string | null };

export interface ReceivedDocumentSyncOutcome {
  documents: ReceivedDocumentDescriptor[];
  sourceCursor: string | null;
}

export interface SunatProviderHealth {
  ready: boolean;
  provider: string;
  environment: SunatProviderEnvironment;
  detail?: string;
}
