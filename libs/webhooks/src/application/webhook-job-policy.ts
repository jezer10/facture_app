import type { TaskOptions } from '@app/platform';

import { assertEventId } from './webhook-validation';

const DEFAULT_ATTEMPTS = 8;
const INITIAL_BACKOFF_MS = 1_000;

export function createWebhookDeliveryJobOptions(eventId: string): TaskOptions {
  const stableJobId = assertEventId(eventId);

  return {
    attempts: DEFAULT_ATTEMPTS,
    backoff: {
      delay: INITIAL_BACKOFF_MS,
      type: 'exponential',
    },
    jobId: stableJobId,
  };
}
