import type { ArtifactReference, EventEnvelope } from './event-envelope';
import type { FiscalDocumentType } from './fiscal-documents';

export type SunatCommandType =
  | 'sunat.document.issue.requested.v1'
  | 'sunat.document.void.requested.v1'
  | 'sunat.received.sync.requested.v1'
  | 'sunat.document.reconcile.requested.v1';

export interface IssueDocumentCommandPayload {
  readonly documentId: string;
  readonly documentType: FiscalDocumentType;
  readonly series: string;
  readonly number: string;
}

export interface SyncReceivedDocumentsCommandPayload {
  readonly syncId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly documentTypes: readonly FiscalDocumentType[];
}

export interface VoidDocumentCommandPayload {
  readonly documentId: string;
  readonly documentType: FiscalDocumentType;
  readonly series: string;
  readonly number: string;
  readonly reason: string;
}

export interface ReconcileDocumentCommandPayload {
  readonly documentId: string;
  readonly submissionId: string;
  readonly ticket?: string;
}

export type SunatCommandEnvelope =
  | EventEnvelope<'sunat.document.issue.requested.v1', IssueDocumentCommandPayload>
  | EventEnvelope<'sunat.document.void.requested.v1', VoidDocumentCommandPayload>
  | EventEnvelope<'sunat.received.sync.requested.v1', SyncReceivedDocumentsCommandPayload>
  | EventEnvelope<'sunat.document.reconcile.requested.v1', ReconcileDocumentCommandPayload>;

export type SunatResultType =
  | 'sunat.document.accepted.v1'
  | 'sunat.document.rejected.v1'
  | 'sunat.document.failed.v1'
  | 'sunat.document.voided.v1'
  | 'sunat.document.reconciling.v1'
  | 'sunat.received.sync.completed.v1'
  | 'sunat.received.sync.failed.v1';

export interface AcceptedDocumentResultPayload {
  readonly documentId: string;
  readonly submissionId: string;
  readonly acceptedAt: string;
  readonly observationCodes: readonly string[];
  readonly artifacts: readonly ArtifactReference[];
}

export interface RejectedDocumentResultPayload {
  readonly documentId: string;
  readonly submissionId: string;
  readonly code: string;
  readonly description: string;
  readonly artifacts: readonly ArtifactReference[];
}

export interface FailedDocumentResultPayload {
  readonly documentId: string;
  readonly submissionId?: string;
  readonly code: string;
  readonly description: string;
  readonly retryable: false;
}

export interface ReconcilingDocumentResultPayload {
  readonly documentId: string;
  readonly submissionId: string;
  readonly ticket?: string;
  readonly nextCheckAt: string;
}

export interface ReceivedSyncCompletedResultPayload {
  readonly syncId: string;
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly recordsRef: string;
  readonly recordsSha256: string;
}

export interface ReceivedSyncFailedResultPayload {
  readonly syncId: string;
  readonly code: string;
  readonly description: string;
  readonly retryable: false;
}

export interface VoidedDocumentResultPayload {
  readonly documentId: string;
  readonly submissionId: string;
  readonly voidedAt: string;
  readonly artifacts: readonly ArtifactReference[];
}

export interface ReceivedDocumentRecord {
  readonly supplierRuc: string;
  readonly documentType: FiscalDocumentType;
  readonly series: string;
  readonly number: string;
  readonly source: string;
  readonly issueDate: string;
  readonly snapshot: Record<string, unknown>;
  readonly snapshotSha256: string;
}

export type SunatResultEnvelope =
  | EventEnvelope<'sunat.document.accepted.v1', AcceptedDocumentResultPayload>
  | EventEnvelope<'sunat.document.rejected.v1', RejectedDocumentResultPayload>
  | EventEnvelope<'sunat.document.failed.v1', FailedDocumentResultPayload>
  | EventEnvelope<'sunat.document.voided.v1', VoidedDocumentResultPayload>
  | EventEnvelope<'sunat.document.reconciling.v1', ReconcilingDocumentResultPayload>
  | EventEnvelope<'sunat.received.sync.completed.v1', ReceivedSyncCompletedResultPayload>
  | EventEnvelope<'sunat.received.sync.failed.v1', ReceivedSyncFailedResultPayload>;
