import type { EncryptedEnvelope, EnvelopeEncryption } from '@app/platform';

export class WebhookSecretCipher {
  constructor(private readonly encryption: EnvelopeEncryption) {}

  encrypt(
    secret: string,
    organizationId: string,
    subscriptionId: string,
    version: number,
  ): EncryptedEnvelope {
    const plaintext = Buffer.from(secret, 'utf8');
    try {
      return this.encryption.encrypt(
        plaintext,
        secretContext(organizationId, subscriptionId, version),
      );
    } finally {
      plaintext.fill(0);
    }
  }

  decrypt(
    envelope: EncryptedEnvelope,
    organizationId: string,
    subscriptionId: string,
    version: number,
  ): string {
    const plaintext = this.encryption.decrypt(
      envelope,
      secretContext(organizationId, subscriptionId, version),
    );
    try {
      return plaintext.toString('utf8');
    } finally {
      plaintext.fill(0);
    }
  }
}

function secretContext(organizationId: string, subscriptionId: string, version: number): string {
  return `webhook:${organizationId}:${subscriptionId}:secret:${version}`;
}
