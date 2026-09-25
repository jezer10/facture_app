import { classifyCredential, inventoryCredentials } from './credential-classifier';
import type { LegacyCompanyRow } from './models';

describe('credential inventory', () => {
  it('classifies values without decrypting or returning them', () => {
    const legacyEnvelope = [
      Buffer.alloc(12, 1).toString('base64'),
      Buffer.alloc(16, 2).toString('base64'),
      Buffer.from('ciphertext').toString('base64'),
    ].join(':');
    const jsonEnvelope = JSON.stringify({
      algorithm: 'AES-256-GCM',
      ciphertext: Buffer.from('ciphertext').toString('base64'),
      dataIv: Buffer.alloc(12, 3).toString('base64'),
      dataKeyIv: Buffer.alloc(12, 4).toString('base64'),
      dataKeyTag: Buffer.alloc(16, 5).toString('base64'),
      dataTag: Buffer.alloc(16, 6).toString('base64'),
      encryptedDataKey: Buffer.from('key').toString('base64'),
      version: 1,
    });

    expect(classifyCredential('plain-secret')).toBe('plaintext');
    expect(classifyCredential(legacyEnvelope)).toBe('envelope');
    expect(classifyCredential(jsonEnvelope)).toBe('envelope');
    expect(classifyCredential('not:an:envelope')).toBe('corrupt');
    expect(classifyCredential('{broken-json')).toBe('corrupt');
  });

  it('counts cached tokens only as discarded and never exposes credential values', () => {
    const secret = 'secret-that-must-not-leak';
    const token = 'access-token-that-must-not-leak';
    const companies: LegacyCompanyRow[] = [
      {
        accessToken: token,
        clientSecret: secret,
        companyPassword: secret,
        id: 'legacy-company',
        recipientRuc: '20123456789',
      },
    ];

    const result = inventoryCredentials(companies);

    expect(result).toEqual({
      accessTokensDiscarded: 1,
      categories: { corrupt: 0, envelope: 0, plaintext: 2 },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
