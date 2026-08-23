import type { JobsOptions } from 'bullmq';

import { assertEventId } from './webhook-validation';

const DEFAULT_ATTEMPTS = 8;
const INITIAL_BACKOFF_MS = 1_000;

export function createWebhookDeliveryJobOptions(eventId: string): JobsOptions {
  const stableJobId = assertEventId(eventId);

  return {
    attempts: DEFAULT_ATTEMPTS,
    backoff: {
      delay: INITIAL_BACKOFF_MS,
      type: 'exponential',
    },
    jobId: stableJobId,
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 604_800, count: 50_000 },
  };
}
