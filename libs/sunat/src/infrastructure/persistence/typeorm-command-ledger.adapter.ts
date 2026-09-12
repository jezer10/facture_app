import type { CompletedSunatCommand } from '../../application/sunat-command-executor';
import { SunatError } from '../../domain/errors/sunat.error';
import type {
  CommandLedgerReservation,
  PendingCommandDelivery,
  SunatCommandLedgerPort,
} from '../../domain/ports/command-ledger.port';
import type { DataSource } from 'typeorm';

interface InboxRow {
  readonly status: 'processing' | 'completed';
  readonly result: CompletedSunatCommand | null;
}

interface DeliveryRow {
  readonly event_id: string;
  readonly result: CompletedSunatCommand;
  readonly delivery_attempts: number;
}

export class TypeOrmCommandLedgerAdapter implements SunatCommandLedgerPort<CompletedSunatCommand> {
  constructor(
    private readonly dataSource: DataSource,
    private readonly staleLockMilliseconds = 5 * 60_000,
  ) {}

  async reserve(
    eventId: string,
    attempt: number,
  ): Promise<CommandLedgerReservation<CompletedSunatCommand>> {
    const inserted = await this.dataSource.query<Array<{ event_id: string }>>(
      `INSERT INTO command_inbox (event_id, status, result, locked_at, processing_attempt)
       VALUES ($1, 'processing', NULL, now(), $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, attempt],
    );
    if (inserted.length === 1) {
      return { state: 'acquired' };
    }

    const recovered = await this.dataSource.query<Array<{ event_id: string }>>(
      `UPDATE command_inbox
       SET locked_at = now(), processing_attempt = $2, updated_at = now()
       WHERE event_id = $1
         AND status = 'processing'
         AND (
           processing_attempt < $2
           OR locked_at < now() - ($3 * interval '1 millisecond')
         )
       RETURNING event_id`,
      [eventId, attempt, this.staleLockMilliseconds],
    );
    if (recovered.length === 1) {
      return { state: 'acquired' };
    }

    const rows = await this.dataSource.query<InboxRow[]>(
      'SELECT status, result FROM command_inbox WHERE event_id = $1',
      [eventId],
    );
    const existing = rows[0];
    if (existing?.status === 'completed') {
      if (!existing.result) {
        throw ledgerCorruptionError();
      }
      return { state: 'completed', result: existing.result };
    }
    return { state: 'processing' };
  }

  async complete(eventId: string, result: CompletedSunatCommand): Promise<void> {
    const rows = await this.dataSource.query<Array<{ event_id: string }>>(
      `UPDATE command_inbox
       SET status = 'completed',
           result = $2::jsonb,
           completed_at = now(),
           delivery_status = 'pending',
           delivery_attempts = 0,
           delivery_available_at = now(),
           delivery_locked_until = NULL,
           last_delivery_error_code = NULL,
           delivered_at = NULL,
           updated_at = now()
       WHERE event_id = $1 AND status = 'processing'
       RETURNING event_id`,
      [eventId, JSON.stringify(result)],
    );
    if (rows.length === 1) {
      return;
    }
    const existing = await this.dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM command_inbox WHERE event_id = $1',
      [eventId],
    );
    if (existing[0]?.status !== 'completed') {
      throw ledgerCorruptionError();
    }
  }

  async release(eventId: string): Promise<void> {
    await this.dataSource.query(
      "DELETE FROM command_inbox WHERE event_id = $1 AND status = 'processing'",
      [eventId],
    );
  }

  async claimPendingDeliveries(
    limit: number,
    leaseMilliseconds: number,
  ): Promise<readonly PendingCommandDelivery<CompletedSunatCommand>[]> {
    const rows = await this.dataSource.query<DeliveryRow[]>(
      `WITH ready AS (
         SELECT event_id
         FROM command_inbox
         WHERE status = 'completed'
           AND delivery_available_at <= now()
           AND (
             delivery_status = 'pending'
             OR (delivery_status = 'publishing' AND delivery_locked_until < now())
           )
         ORDER BY delivery_available_at ASC, completed_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE command_inbox AS inbox
       SET delivery_status = 'publishing',
           delivery_attempts = delivery_attempts + 1,
           delivery_locked_until = now() + ($2 * interval '1 millisecond'),
           updated_at = now()
       FROM ready
       WHERE inbox.event_id = ready.event_id
       RETURNING inbox.event_id, inbox.result, inbox.delivery_attempts`,
      [limit, leaseMilliseconds],
    );
    return rows.map((row) => ({
      eventId: row.event_id,
      result: row.result,
      attempt: row.delivery_attempts,
    }));
  }

  async markDelivered(eventId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE command_inbox
       SET delivery_status = 'delivered',
           delivery_locked_until = NULL,
           last_delivery_error_code = NULL,
           delivered_at = COALESCE(delivered_at, now()),
           updated_at = now()
       WHERE event_id = $1 AND status = 'completed'`,
      [eventId],
    );
  }

  async rescheduleDelivery(eventId: string, errorCode: string, availableAt: Date): Promise<void> {
    await this.dataSource.query(
      `UPDATE command_inbox
       SET delivery_status = 'pending',
           delivery_available_at = $3,
           delivery_locked_until = NULL,
           last_delivery_error_code = $2,
           updated_at = now()
       WHERE event_id = $1
         AND status = 'completed'
         AND delivery_status <> 'delivered'`,
      [eventId, errorCode, availableAt],
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
        detail: 'La base billing_sunat no está disponible.',
      };
    }
  }
}

function ledgerCorruptionError(): SunatError {
  return new SunatError({
    category: 'data_integrity',
    code: 'SUNAT_COMMAND_LEDGER_CORRUPT',
    message: 'El ledger durable de comandos SUNAT tiene un estado inválido.',
  });
}
