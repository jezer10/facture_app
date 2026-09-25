import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS,
  WEBHOOK_HEADERS,
  WEBHOOK_SIGNATURE_VERSION,
} from '../domain/webhook.constants';
import { checkWebhookReplayWindow } from './webhook-replay-window';

export interface CreateWebhookHeadersInput {
  readonly eventId: string;
  readonly eventType: string;
  readonly rawBody: string;
  readonly secret: string;
  readonly timestamp: string;
}

export interface VerifyWebhookSignatureInput {
  readonly now?: Date;
  readonly rawBody: string;
  readonly replayWindowSeconds?: number;
  readonly secret: string;
  readonly signatureHeader: string;
  readonly timestampHeader: string;
}

export type WebhookSignatureVerification =
  | { readonly valid: true }
  | {
      readonly reason: 'invalid_signature' | 'invalid_timestamp' | 'outside_replay_window';
      readonly valid: false;
    };

export function createWebhookSignature(secret: string, timestamp: string, rawBody: string): string {
  if (secret.length === 0) {
    throw new TypeError('Webhook signing secret must not be empty');
  }

  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  return `${WEBHOOK_SIGNATURE_VERSION}=${digest}`;
}

export function createWebhookHeaders(
  input: CreateWebhookHeadersInput,
): Readonly<Record<string, string>> {
  return {
    'content-type': 'application/json',
    [WEBHOOK_HEADERS.eventId]: input.eventId,
    [WEBHOOK_HEADERS.eventType]: input.eventType,
    [WEBHOOK_HEADERS.signature]: createWebhookSignature(
      input.secret,
      input.timestamp,
      input.rawBody,
    ),
    [WEBHOOK_HEADERS.timestamp]: input.timestamp,
    [WEBHOOK_HEADERS.version]: WEBHOOK_SIGNATURE_VERSION,
  };
}

export function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): WebhookSignatureVerification {
  const replayCheck = checkWebhookReplayWindow(
    input.timestampHeader,
    input.now ?? new Date(),
    input.replayWindowSeconds ?? DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS,
  );

  if (!replayCheck.accepted) {
    return {
      valid: false,
      reason:
        replayCheck.reason === 'outside_window' ? 'outside_replay_window' : 'invalid_timestamp',
    };
  }

  const providedDigest = parseVersionedSignature(input.signatureHeader);
  if (providedDigest === undefined) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const expectedSignature = createWebhookSignature(
    input.secret,
    input.timestampHeader,
    input.rawBody,
  );
  const expectedDigest = parseVersionedSignature(expectedSignature);

  if (
    expectedDigest === undefined ||
    !timingSafeEqual(Buffer.from(providedDigest, 'hex'), Buffer.from(expectedDigest, 'hex'))
  ) {
    return { valid: false, reason: 'invalid_signature' };
  }

  return { valid: true };
}

function parseVersionedSignature(signature: string): string | undefined {
  const match = /^v1=([a-f0-9]{64})$/i.exec(signature);
  return match?.[1]?.toLowerCase();
}
