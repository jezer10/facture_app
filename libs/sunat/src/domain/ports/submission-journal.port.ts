import type { FiscalDocumentIdentity, FiscalDocumentType } from '../models/fiscal-document';

export const SUNAT_SUBMISSION_JOURNAL_PORT = Symbol('SUNAT_SUBMISSION_JOURNAL_PORT');

export type SubmissionOperation = 'issue' | 'void' | 'daily_summary';
export type SubmissionAttemptOutcome = 'accepted' | 'rejected' | 'pending' | 'ambiguous' | 'failed';

export interface BeginSubmissionInput {
  readonly commandEventId: string;
  readonly organizationId: string;
  readonly issuerId: string;
  readonly identity: FiscalDocumentIdentity;
  readonly operation: SubmissionOperation;
  readonly payloadSha256: string;
}

export interface BeginSubmissionResult {
  readonly submissionId: string;
  readonly acquired: boolean;
  readonly status:
    | 'processing'
    | 'submitted'
    | 'reconciling'
    | 'accepted'
    | 'rejected'
    | 'voided'
    | 'failed';
  readonly providerTrackingId: string | null;
  readonly ticket: string | null;
  readonly responseCode: string | null;
  readonly responseDescription: string | null;
}

export interface RecordSubmissionAttemptInput {
  readonly submissionId: string;
  readonly attemptNumber: number;
  readonly endpoint: string;
  readonly outcome: SubmissionAttemptOutcome;
  readonly errorCode?: string;
  readonly providerTrackingId?: string | null;
  readonly ticket?: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

export interface CompleteSubmissionInput {
  readonly submissionId: string;
  readonly status: 'accepted' | 'rejected' | 'voided' | 'reconciling' | 'failed';
  readonly providerTrackingId?: string | null;
  readonly ticket?: string | null;
  readonly responseCode?: string | null;
  readonly responseDescription?: string | null;
}

export interface UpdateReceivedSyncCursorInput {
  readonly issuerId: string;
  readonly documentType: FiscalDocumentType;
  readonly source: string;
  readonly lastIssueDate: string;
  readonly providerCursor: string | null;
  readonly syncedAt: Date;
}

export interface FindSubmissionForReconciliationInput {
  readonly issuerId: string;
  readonly identity: FiscalDocumentIdentity;
  readonly providerTrackingId: string;
  readonly ticket?: string;
}

export interface SunatSubmissionJournalPort {
  begin(input: BeginSubmissionInput): Promise<BeginSubmissionResult>;
  recordAttempt(input: RecordSubmissionAttemptInput): Promise<void>;
  complete(input: CompleteSubmissionInput): Promise<void>;
  findForReconciliation(
    input: FindSubmissionForReconciliationInput,
  ): Promise<{ submissionId: string } | null>;
  updateReceivedSyncCursor(input: UpdateReceivedSyncCursorInput): Promise<void>;
  readiness(): Promise<{ ready: boolean; durable: boolean; detail?: string }>;
}
