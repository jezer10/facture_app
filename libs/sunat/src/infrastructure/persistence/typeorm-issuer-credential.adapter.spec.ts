import { EnvelopeEncryption } from '@app/platform';
import type { Repository } from 'typeorm';

import { IssuerCredentialEntity } from '../../database/entities';
import { TypeOrmIssuerCredentialAdapter } from './typeorm-issuer-credential.adapter';

describe('TypeOrmIssuerCredentialAdapter', () => {
  it('returns only opaque handles and decrypts SOL values inside the vault boundary', async () => {
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 7));
    const credential = credentialEntity(encryption);
    const repository = {
      findOne: jest.fn().mockResolvedValue(credential),
      findOneBy: jest.fn().mockResolvedValue(credential),
      query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as unknown as Repository<IssuerCredentialEntity>;
    const adapter = new TypeOrmIssuerCredentialAdapter(repository, encryption);

    const handle = await adapter.resolve(credential.issuerId);

    expect(handle).toEqual(
      expect.objectContaining({
        issuerId: credential.issuerId,
        credentialVersion: 3,
        certificateFingerprint: null,
      }),
    );
    expect(JSON.stringify(handle)).not.toContain('sol-password');
    expect(JSON.stringify(handle)).not.toContain('SOLUSER');
    await expect(adapter.loadSolCredentials(handle)).resolves.toEqual({
      ruc: credential.issuerRuc,
      username: 'SOLUSER',
      password: 'sol-password',
    });
  });

  it('fails closed when an opaque handle points at an inactive version', async () => {
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 9));
    const credential = credentialEntity(encryption);
    const repository = {
      findOne: jest.fn().mockResolvedValue(credential),
      findOneBy: jest.fn().mockResolvedValue(null),
    } as unknown as Repository<IssuerCredentialEntity>;
    const adapter = new TypeOrmIssuerCredentialAdapter(repository, encryption);
    const handle = await adapter.resolve(credential.issuerId);

    await expect(adapter.loadSolCredentials(handle)).rejects.toMatchObject({
      code: 'SUNAT_CREDENTIAL_UNAVAILABLE',
    });
  });
});

function credentialEntity(encryption: EnvelopeEncryption): IssuerCredentialEntity {
  const issuerId = '0198f176-2ca2-7000-8000-000000000002';
  const version = 3;
  const plaintext = Buffer.from(
    JSON.stringify({
      ruc: '20123456789',
      username: 'SOLUSER',
      password: 'sol-password',
    }),
    'utf8',
  );
  try {
    return Object.assign(new IssuerCredentialEntity(), {
      id: '0198f176-2ca2-7000-8000-000000000003',
      organizationId: '0198f176-2ca2-7000-8000-000000000001',
      issuerId,
      issuerRuc: '20123456789',
      environment: 'beta' as const,
      version,
      solEnvelope: encryption.encrypt(plaintext, `sunat:issuer:${issuerId}:version:${version}:sol`),
      certificateEnvelope: null,
      certificateArchiveSha256: null,
      certificateExpiresAt: null,
      active: true,
      createdAt: new Date('2026-08-22T00:00:00.000Z'),
      updatedAt: new Date('2026-08-22T00:00:00.000Z'),
    });
  } finally {
    plaintext.fill(0);
  }
}
