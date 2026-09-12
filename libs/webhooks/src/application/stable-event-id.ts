import { createHash } from 'node:crypto';

import { canonicalJsonStringify } from './canonical-json';

export interface StableWebhookEventIdentity {
  readonly eventType: string;
  readonly organizationId: string;
  readonly source: string;
  readonly sourceEventId: string;
}

export function createStableWebhookEventId(identity: StableWebhookEventIdentity): string {
  assertIdentityPart(identity.organizationId, 'organizationId');
  assertIdentityPart(identity.source, 'source');
  assertIdentityPart(identity.sourceEventId, 'sourceEventId');
  assertIdentityPart(identity.eventType, 'eventType');

  const canonicalIdentity = canonicalJsonStringify({
    eventType: identity.eventType,
    organizationId: identity.organizationId,
    source: identity.source,
    sourceEventId: identity.sourceEventId,
  });
  const digest = createHash('sha256').update(canonicalIdentity, 'utf8').digest('hex');

  return `evt_${digest}`;
}

function assertIdentityPart(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}
