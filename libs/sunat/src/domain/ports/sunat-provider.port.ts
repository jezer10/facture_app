import type {
  FiscalDocumentIdentity,
  ReceivedDocumentSyncRequest,
} from '../models/fiscal-document';
import type {
  IssuerCredentialHandle,
  ReceivedDocumentSyncOutcome,
  SignedUblDocument,
  SunatProviderHealth,
  SunatReconciliationOutcome,
  SunatSubmissionOutcome,
  SunatVoidOutcome,
} from '../models/sunat-outcome';

import type { StoredSunatArtifact } from './sunat-artifact-store.port';

export const SUNAT_PROVIDER_PORT = Symbol('SUNAT_PROVIDER_PORT');

export interface SunatProviderPort {
  storedArtifacts?(
    identity: FiscalDocumentIdentity,
    credentials: IssuerCredentialHandle,
  ): Promise<readonly StoredSunatArtifact[]>;
  submitDocument(
    document: SignedUblDocument,
    credentials: IssuerCredentialHandle,
    context?: { organizationId: string },
  ): Promise<SunatSubmissionOutcome>;

  submitVoidCommunication(
    identity: FiscalDocumentIdentity,
    reason: string,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatVoidOutcome>;

  reconcileDocument(
    identity: FiscalDocumentIdentity,
    providerTrackingId: string | null,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatReconciliationOutcome>;

  listReceivedDocuments(
    request: ReceivedDocumentSyncRequest,
    credentials: IssuerCredentialHandle,
  ): Promise<ReceivedDocumentSyncOutcome>;

  health(): Promise<SunatProviderHealth>;
}
