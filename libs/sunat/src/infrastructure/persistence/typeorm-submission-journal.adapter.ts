import type { DataSource } from 'typeorm';

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

interface SubmissionRow {
  readonly id: string;
  readonly payload_sha256: string;
  readonly status: BeginSubmissionResult['status'];
  readonly provider_tracking_id: string | null;
  readonly ticket: string | null;
  readonly response_code: string | null;
  readonly response_description: string | null;
}

export class TypeOrmSubmissionJournalAdapter implements SunatSubmissionJournalPort {
  constructor(private readonly dataSource: DataSource) {}

  async begin(input: BeginSubmissionInput): Promise<BeginSubmissionResult> {
    const identity = input.identity;
    const rows = await this.dataSource.query<SubmissionRow[]>(
      `INSERT INTO submissions
        (command_event_id, organization_id, issuer_id, document_id, issuer_ruc,
         document_type, series, number, operation, status, payload_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'processing',$10)
       ON CONFLICT (issuer_id, document_type, series, number, operation)
       DO NOTHING
       RETURNING id, payload_sha256, status, provider_tracking_id, ticket,
         response_code, response_description`,
      [
        input.commandEventId,
        input.organizationId,
        input.issuerId,
        identity.documentId,
        identity.issuerRuc,
        identity.documentType,
        identity.series,
        identity.number,
        input.operation,
        input.payloadSha256,
      ],
    );
    const inserted = rows[0];
    const existing =
      inserted ??
      (
        await this.dataSource.query<SubmissionRow[]>(
          `SELECT id, payload_sha256, status, provider_tracking_id, ticket,
             response_code, response_description FROM submissions
         WHERE issuer_id=$1 AND document_type=$2 AND series=$3 AND number=$4 AND operation=$5`,
          [
            input.issuerId,
            identity.documentType,
            identity.series,
            identity.number,
            input.operation,
          ],
        )
      )[0];
    if (!existing || existing.payload_sha256 !== input.payloadSha256) {
      throw new SunatPayloadIntegrityError(
        'La identidad fiscal ya está asociada a un payload SUNAT diferente.',
      );
    }
    return {
      submissionId: existing.id,
      acquired: inserted !== undefined,
      status: existing.status,
      providerTrackingId: existing.provider_tracking_id,
      ticket: existing.ticket,
      responseCode: existing.response_code,
      responseDescription: existing.response_description,
    };
  }

  async recordAttempt(input: RecordSubmissionAttemptInput): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO submission_attempts
        (submission_id, attempt_number, endpoint, outcome, http_status, error_code,
         provider_tracking_id, ticket, started_at, completed_at)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9)
       ON CONFLICT (submission_id, attempt_number)
       DO UPDATE SET outcome=EXCLUDED.outcome, error_code=EXCLUDED.error_code,
         provider_tracking_id=COALESCE(EXCLUDED.provider_tracking_id,
           submission_attempts.provider_tracking_id),
         ticket=COALESCE(EXCLUDED.ticket, submission_attempts.ticket),
         completed_at=EXCLUDED.completed_at`,
      [
        input.submissionId,
        input.attemptNumber,
        input.endpoint,
        input.outcome,
        input.errorCode ?? null,
        input.providerTrackingId ?? null,
        input.ticket ?? null,
        input.startedAt,
        input.completedAt,
      ],
    );
    await this.dataSource.query(
      `UPDATE submissions SET
        status=$2,
        provider_tracking_id=COALESCE($3, provider_tracking_id),
        ticket=COALESCE($4, ticket),
        updated_at=now()
       WHERE id=$1`,
      [
        input.submissionId,
        input.outcome === 'pending' || input.outcome === 'ambiguous'
          ? 'reconciling'
          : input.outcome === 'failed'
            ? 'failed'
            : input.outcome,
        input.providerTrackingId ?? null,
        input.ticket ?? null,
      ],
    );
    if (input.ticket) {
      await this.upsertTicket(input.submissionId, input.ticket, input.completedAt);
    }
  }

  async complete(input: CompleteSubmissionInput): Promise<void> {
    await this.dataSource.query(
      `UPDATE submissions SET status=$2, provider_tracking_id=COALESCE($3,provider_tracking_id),
        ticket=COALESCE($4,ticket), response_code=$5, response_description=$6, updated_at=now()
       WHERE id=$1`,
      [
        input.submissionId,
        input.status,
        input.providerTrackingId ?? null,
        input.ticket ?? null,
        input.responseCode ?? null,
        input.responseDescription ?? null,
      ],
    );
    if (input.ticket) {
      await this.dataSource.query(
        `UPDATE submission_tickets SET status=$2, completed_at=now(),
          last_checked_at=now(), updated_at=now() WHERE ticket=$1`,
        [
          input.ticket,
          input.status === 'accepted' || input.status === 'voided'
            ? 'completed'
            : input.status === 'rejected' || input.status === 'failed'
              ? 'failed'
              : 'pending',
        ],
      );
    }
  }

  async findForReconciliation(
    input: FindSubmissionForReconciliationInput,
  ): Promise<{ submissionId: string } | null> {
    const rows = await this.dataSource.query<Array<{ id?: unknown }>>(
      `SELECT id FROM submissions
       WHERE issuer_id=$1 AND document_type=$2 AND series=$3 AND number=$4
         AND (provider_tracking_id=$5 OR ($6::varchar IS NOT NULL AND ticket=$6)
           OR status IN ('processing','submitted','reconciling'))
       ORDER BY COALESCE(provider_tracking_id=$5 OR ticket=$6, false) DESC,
         updated_at DESC
       LIMIT 1`,
      [
        input.issuerId,
        input.identity.documentType,
        input.identity.series,
        input.identity.number,
        input.providerTrackingId,
        input.ticket ?? null,
      ],
    );
    const submission = rows[0];
    return typeof submission?.id === 'string' ? { submissionId: submission.id } : null;
  }

  async updateReceivedSyncCursor(input: UpdateReceivedSyncCursorInput): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO received_sync_cursors
        (issuer_id, document_type, source, last_issue_date, provider_cursor, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (issuer_id, document_type, source)
       DO UPDATE SET last_issue_date=EXCLUDED.last_issue_date,
        provider_cursor=EXCLUDED.provider_cursor, last_synced_at=EXCLUDED.last_synced_at,
        updated_at=now()`,
      [
        input.issuerId,
        input.documentType,
        input.source,
        input.lastIssueDate,
        input.providerCursor,
        input.syncedAt,
      ],
    );
  }

  async readiness(): Promise<{
    ready: boolean;
    durable: true;
    detail?: string;
  }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { ready: true, durable: true };
    } catch {
      return {
        ready: false,
        durable: true,
        detail: 'El journal durable de envíos SUNAT no está disponible.',
      };
    }
  }

  private async upsertTicket(submissionId: string, ticket: string, checkedAt: Date): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO submission_tickets
        (submission_id, ticket, status, last_checked_at, next_check_at)
       VALUES ($1,$2,'pending',$3,$3)
       ON CONFLICT (ticket) DO UPDATE SET last_checked_at=EXCLUDED.last_checked_at,
        updated_at=now()`,
      [submissionId, ticket, checkedAt],
    );
  }
}
