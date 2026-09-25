export interface ReplayWindowCheck {
  readonly accepted: boolean;
  readonly reason?: 'invalid_timestamp' | 'outside_window';
}

export function checkWebhookReplayWindow(
  timestamp: string,
  now: Date,
  toleranceSeconds: number,
): ReplayWindowCheck {
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError('Replay tolerance must be a non-negative integer');
  }
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('Replay comparison time must be a valid date');
  }

  if (!/^(0|[1-9]\d{0,12})$/.test(timestamp)) {
    return { accepted: false, reason: 'invalid_timestamp' };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return { accepted: false, reason: 'invalid_timestamp' };
  }

  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const distanceSeconds = Math.abs(nowSeconds - timestampSeconds);

  if (distanceSeconds > toleranceSeconds) {
    return { accepted: false, reason: 'outside_window' };
  }

  return { accepted: true };
}
