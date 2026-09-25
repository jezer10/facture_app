import { randomBytes } from 'node:crypto';

import { EnvelopeEncryption } from '@app/platform';

import { WebhookSecretCipher } from './webhook-secret-cipher';

describe('WebhookSecretCipher', () => {
  it('encrypts HMAC secrets without retaining plaintext in the envelope', () => {
    const cipher = new WebhookSecretCipher(new EnvelopeEncryption(randomBytes(32)));
    const secret = 's'.repeat(32);
    const encrypted = cipher.encrypt(
      secret,
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      1,
    );

    expect(JSON.stringify(encrypted)).not.toContain(secret);
    expect(
      cipher.decrypt(
        encrypted,
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        1,
      ),
    ).toBe(secret);
  });

  it('binds ciphertext to organization, subscription and version', () => {
    const cipher = new WebhookSecretCipher(new EnvelopeEncryption(randomBytes(32)));
    const encrypted = cipher.encrypt(
      's'.repeat(32),
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      1,
    );

    expect(() =>
      cipher.decrypt(
        encrypted,
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000002',
        1,
      ),
    ).toThrow();
  });
});
