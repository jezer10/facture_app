import { createHmac } from 'node:crypto';

import { canonicalJsonStringify } from './canonical-json';
import { createStableWebhookEventId } from './stable-event-id';
import {
  createWebhookHeaders,
  createWebhookSignature,
  verifyWebhookSignature,
} from './webhook-signature';
import { WEBHOOK_HEADERS } from '../domain/webhook.constants';

describe('webhook cryptographic helpers', () => {
  const secret = 's'.repeat(32);
  const timestamp = '1787356800';

  it('canonicalizes nested JSON objects while preserving array order', () => {
    const left = canonicalJsonStringify({
      z: [{ y: 2, x: 1 }, 'last'],
      a: true,
    });
    const right = canonicalJsonStringify({
      a: true,
      z: [{ x: 1, y: 2 }, 'last'],
    });

    expect(left).toBe('{"a":true,"z":[{"x":1,"y":2},"last"]}');
    expect(right).toBe(left);
  });

  it('signs exactly timestamp + dot + rawBody with a versioned header', () => {
    const rawBody = '{"a":1}';
    const expectedDigest = createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');

    expect(createWebhookSignature(secret, timestamp, rawBody)).toBe(`v1=${expectedDigest}`);
  });

  it('verifies a signature only inside the replay window', () => {
    const rawBody = '{"event":"accepted"}';
    const signature = createWebhookSignature(secret, timestamp, rawBody);
    const now = new Date(Number(timestamp) * 1_000);

    expect(
      verifyWebhookSignature({
        now,
        rawBody,
        secret,
        signatureHeader: signature,
        timestampHeader: timestamp,
      }),
    ).toEqual({ valid: true });

    expect(
      verifyWebhookSignature({
        now: new Date(now.getTime() + 301_000),
        rawBody,
        secret,
        signatureHeader: signature,
        timestampHeader: timestamp,
      }),
    ).toEqual({ valid: false, reason: 'outside_replay_window' });
  });

  it('rejects payload tampering and exposes the stable event header', () => {
    const rawBody = '{"event":"accepted"}';
    const headers = createWebhookHeaders({
      eventId: 'evt_123',
      eventType: 'invoice.accepted.v1',
      rawBody,
      secret,
      timestamp,
    });

    expect(headers[WEBHOOK_HEADERS.eventId]).toBe('evt_123');
    expect(
      verifyWebhookSignature({
        now: new Date(Number(timestamp) * 1_000),
        rawBody: '{"event":"rejected"}',
        secret,
        signatureHeader: headers[WEBHOOK_HEADERS.signature] ?? '',
        timestampHeader: timestamp,
      }),
    ).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('derives the same event id from the same logical source identity', () => {
    const first = createStableWebhookEventId({
      eventType: 'invoice.accepted.v1',
      organizationId: 'tenant-1',
      source: 'billing-worker',
      sourceEventId: 'invoice-42:accepted',
    });
    const second = createStableWebhookEventId({
      organizationId: 'tenant-1',
      sourceEventId: 'invoice-42:accepted',
      source: 'billing-worker',
      eventType: 'invoice.accepted.v1',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^evt_[a-f0-9]{64}$/);
  });
});
