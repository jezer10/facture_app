export interface OutboxRetryDecision {
  readonly availableAt: Date;
  readonly status: 'pending' | 'retrying';
}

const FAST_RETRY_ATTEMPTS = 10;
const MAX_FAST_RETRY_DELAY_MS = 60_000;
const INITIAL_DEGRADED_RETRY_DELAY_MS = 60_000;
const MAX_DEGRADED_RETRY_DELAY_MS = 15 * 60_000;

export function nextOutboxRetry(attempts: number, now: Date): OutboxRetryDecision {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Outbox attempts must be a positive integer');
  }
  const delayMilliseconds =
    attempts < FAST_RETRY_ATTEMPTS
      ? Math.min(MAX_FAST_RETRY_DELAY_MS, 2 ** Math.min(attempts, 10) * 250)
      : Math.min(
          MAX_DEGRADED_RETRY_DELAY_MS,
          INITIAL_DEGRADED_RETRY_DELAY_MS * 2 ** Math.min(attempts - FAST_RETRY_ATTEMPTS, 10),
        );
  return {
    availableAt: new Date(now.getTime() + delayMilliseconds),
    status: attempts < FAST_RETRY_ATTEMPTS ? 'pending' : 'retrying',
  };
}
