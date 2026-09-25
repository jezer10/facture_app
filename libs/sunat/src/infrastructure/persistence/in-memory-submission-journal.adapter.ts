import { createHash } from 'node:crypto';

import { SunatPayloadIntegrityError } from '../../domain/errors/sunat.error';
import type {
  BeginSubmissionInput,
  BeginSubmissionResult,
  CompleteSubmissionInput,
  FindSubmissionForReconciliationInput,
  RecordSubmissionAttemptInput,
  SunatSubmissionJournalPort,
  UpdateReceivedSyncCursorInput,
} from '../../domain/ports/submission-journal.port';

interface MemorySubmission {
  readonly id: string;
  readonly input: BeginSubmissionInput;
  readonly attempts: Map<number, RecordSubmissionAttemptInput>;
  completion?: CompleteSubmissionInput;
}

export class InMemorySubmissionJournalAdapter implements SunatSubmissionJournalPort {
  private readonly submissions = new Map<string, MemorySubmission>();
  private readonly cursors = new Map<string, UpdateReceivedSyncCursorInput>();

  begin(input: BeginSubmissionInput): Promise<BeginSubmissionResult> {
    const key = submissionKey(input);
    const existing = this.submissions.get(key);
    if (existing) {
      if (existing.input.payloadSha256 !== input.payloadSha256) {
        return Promise.reject(new SunatPayloadIntegrityError());
      }
      return Promise.resolve(toBeginResult(existing, false));
    }
    const id = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
    const submission: MemorySubmission = {
      id,
      input,
      attempts: new Map(),
    };
    this.submissions.set(key, submission);
    return Promise.resolve(toBeginResult(submission, true));
  }

  recordAttempt(input: RecordSubmissionAttemptInput): Promise<void> {
    const submission = this.findById(input.submissionId);
    submission.attempts.set(input.attemptNumber, input);
    return Promise.resolve();
  }

  complete(input: CompleteSubmissionInput): Promise<void> {
    this.findById(input.submissionId).completion = input;
    return Promise.resolve();
  }

  findForReconciliation(
    input: FindSubmissionForReconciliationInput,
  ): Promise<{ submissionId: string } | null> {
    const found = [...this.submissions.values()].find((submission) => {
      const identity = submission.input.identity;
      const completion = submission.completion;
      return (
        submission.input.issuerId === input.issuerId &&
        identity.documentType === input.identity.documentType &&
        identity.series === input.identity.series &&
        identity.number === input.identity.number &&
        (completion?.providerTrackingId === input.providerTrackingId ||
          (input.ticket !== undefined && completion?.ticket === input.ticket) ||
          completion === undefined ||
          completion.status === 'reconciling')
      );
    });
    return Promise.resolve(found ? { submissionId: found.id } : null);
  }

  updateReceivedSyncCursor(input: UpdateReceivedSyncCursorInput): Promise<void> {
    this.cursors.set(`${input.issuerId}:${input.documentType}:${input.source}`, input);
    return Promise.resolve();
  }

  readiness(): Promise<{
    ready: true;
    durable: false;
    detail: string;
  }> {
    return Promise.resolve({
      ready: true,
      durable: false,
      detail: 'Journal SUNAT en memoria; sólo apto para mock y pruebas.',
    });
  }

  private findById(id: string): MemorySubmission {
    const submission = [...this.submissions.values()].find((candidate) => candidate.id === id);
    if (!submission) {
      throw new SunatPayloadIntegrityError('El journal no contiene el envío SUNAT indicado.');
    }
    return submission;
  }
}

function submissionKey(input: BeginSubmissionInput): string {
  const identity = input.identity;
  return [
    input.issuerId,
    identity.documentType,
    identity.series,
    identity.number,
    input.operation,
  ].join(':');
}

function toBeginResult(submission: MemorySubmission, acquired: boolean): BeginSubmissionResult {
  return {
    submissionId: submission.id,
    acquired,
    status: submission.completion?.status ?? 'processing',
    providerTrackingId: submission.completion?.providerTrackingId ?? null,
    ticket: submission.completion?.ticket ?? null,
    responseCode: submission.completion?.responseCode ?? null,
    responseDescription: submission.completion?.responseDescription ?? null,
  };
}
