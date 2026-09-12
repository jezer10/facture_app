export const SUNAT_COMMAND_LEDGER_PORT = Symbol('SUNAT_COMMAND_LEDGER_PORT');

export type CommandLedgerReservation<TResult> =
  | { state: 'acquired' }
  | { state: 'processing' }
  | { state: 'completed'; result: TResult };

export interface PendingCommandDelivery<TResult> {
  readonly eventId: string;
  readonly result: TResult;
  readonly attempt: number;
}

export interface SunatCommandLedgerPort<TResult = unknown> {
  reserve(eventId: string, attempt: number): Promise<CommandLedgerReservation<TResult>>;
  complete(eventId: string, result: TResult): Promise<void>;
  release(eventId: string): Promise<void>;
  claimPendingDeliveries(
    limit: number,
    leaseMilliseconds: number,
  ): Promise<readonly PendingCommandDelivery<TResult>[]>;
  markDelivered(eventId: string): Promise<void>;
  rescheduleDelivery(eventId: string, errorCode: string, availableAt: Date): Promise<void>;
  readiness(): Promise<{ ready: boolean; durable: boolean; detail?: string }>;
}
