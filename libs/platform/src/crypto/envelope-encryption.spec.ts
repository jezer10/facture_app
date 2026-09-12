import { randomBytes } from 'node:crypto';
import { EnvelopeEncryption } from './envelope-encryption';

describe('EnvelopeEncryption', () => {
  it('round-trips a secret with bound context', () => {
    const encryption = new EnvelopeEncryption(randomBytes(32));
    const envelope = encryption.encrypt(Buffer.from('SOL password'), 'issuer:123');

    expect(encryption.decrypt(envelope, 'issuer:123').toString('utf8')).toBe('SOL password');
  });

  it('rejects a different context', () => {
    const encryption = new EnvelopeEncryption(randomBytes(32));
    const envelope = encryption.encrypt(Buffer.from('certificate'), 'issuer:123');

    expect(() => encryption.decrypt(envelope, 'issuer:456')).toThrow();
  });

  it('rejects a master key with the wrong length', () => {
    expect(() => new EnvelopeEncryption(Buffer.alloc(31))).toThrow(/32 bytes/u);
  });
});
