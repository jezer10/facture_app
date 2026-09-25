import type {
  CommandLedgerReservation,
  PendingCommandDelivery,
  SunatCommandLedgerPort,
} from '../../domain/ports/command-ledger.port';

type LedgerEntry<TResult> =
  | { state: 'processing'; attempt: number }
  | {
      state: 'completed';
      result: TResult;
      deliveryStatus: 'pending' | 'publishing' | 'delivered';
      deliveryAttempts: number;
      deliveryAvailableAt: number;
      deliveryLockedUntil: number | null;
    };

/** Process-local implementation for tests and explicit mock deployments only. */
export class InMemoryCommandLedgerAdapter<TResult> implements SunatCommandLedgerPort<TResult> {
  private readonly entries = new Map<string, LedgerEntry<TResult>>();

  reserve(eventId: string, attempt: number): Promise<CommandLedgerReservation<TResult>> {
    const existing = this.entries.get(eventId);
    if (existing?.state === 'completed') {
      return Promise.resolve({ state: 'completed', result: existing.result });
    }
    if (existing?.state === 'processing') {
      if (attempt > existing.attempt) {
        this.entries.set(eventId, { state: 'processing', attempt });
        return Promise.resolve({ state: 'acquired' });
      }
      return Promise.resolve({ state: 'processing' });
    }
    this.entries.set(eventId, { state: 'processing', attempt });
    return Promise.resolve({ state: 'acquired' });
  }

  complete(eventId: string, result: TResult): Promise<void> {
    const existing = this.entries.get(eventId);
    if (existing?.state === 'completed') {
      return Promise.resolve();
    }
    if (existing?.state !== 'processing') {
      return Promise.reject(new Error('SUNAT_COMMAND_LEDGER_CORRUPT'));
    }
    this.entries.set(eventId, {
      state: 'completed',
      result,
      deliveryStatus: 'pending',
      deliveryAttempts: 0,
      deliveryAvailableAt: Date.now(),
      deliveryLockedUntil: null,
    });
    return Promise.resolve();
  }

  release(eventId: string): Promise<void> {
    if (this.entries.get(eventId)?.state === 'processing') {
      this.entries.delete(eventId);
    }
    return Promise.resolve();
  }

  claimPendingDeliveries(
    limit: number,
    leaseMilliseconds: number,
  ): Promise<readonly PendingCommandDelivery<TResult>[]> {
    const now = Date.now();
    const claimed: PendingCommandDelivery<TResult>[] = [];
    for (const [eventId, entry] of this.entries) {
      if (claimed.length >= limit) {
        break;
      }
      if (
        entry.state !== 'completed' ||
        entry.deliveryStatus === 'delivered' ||
        entry.deliveryAvailableAt > now ||
        (entry.deliveryStatus === 'publishing' &&
          entry.deliveryLockedUntil !== null &&
          entry.deliveryLockedUntil >= now)
      ) {
        continue;
      }
      entry.deliveryStatus = 'publishing';
      entry.deliveryAttempts += 1;
      entry.deliveryLockedUntil = now + leaseMilliseconds;
      claimed.push({ eventId, result: entry.result, attempt: entry.deliveryAttempts });
    }
    return Promise.resolve(claimed);
  }

  markDelivered(eventId: string): Promise<void> {
    const entry = this.entries.get(eventId);
    if (entry?.state === 'completed') {
      entry.deliveryStatus = 'delivered';
      entry.deliveryLockedUntil = null;
    }
    return Promise.resolve();
  }

  rescheduleDelivery(eventId: string, _errorCode: string, availableAt: Date): Promise<void> {
    const entry = this.entries.get(eventId);
    if (entry?.state === 'completed' && entry.deliveryStatus !== 'delivered') {
      entry.deliveryStatus = 'pending';
      entry.deliveryAvailableAt = availableAt.getTime();
      entry.deliveryLockedUntil = null;
    }
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
      detail: 'Ledger en memoria; sólo apto para mock y pruebas.',
    });
  }
}
