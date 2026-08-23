import { EnvelopeEncryption } from '@app/platform';
import type { DataSource, DeepPartial, EntityManager, Repository } from 'typeorm';

import { IssuerCredentialEntity } from '../database/entities';
import { issuerCredentialEncryptionContext } from '../infrastructure/persistence/typeorm-issuer-credential.adapter';
import { IssuerCredentialProvisioningService } from './issuer-credential-provisioning.service';

describe('IssuerCredentialProvisioningService', () => {
  it('persists encrypted envelopes and returns metadata without credentials', async () => {
    const encryption = new EnvelopeEncryption(Buffer.alloc(32, 5));
    let savedEntity: IssuerCredentialEntity | undefined;
    const repository = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      create: jest.fn((input: DeepPartial<IssuerCredentialEntity>) =>
        Object.assign(new IssuerCredentialEntity(), input, {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
          createdAt: new Date('2026-08-22T00:00:00.000Z'),
          updatedAt: new Date('2026-08-22T00:00:00.000Z'),
        }),
      ),
      save: jest.fn((entity: IssuerCredentialEntity) => {
        savedEntity = entity;
        return Promise.resolve(entity);
      }),
    } as unknown as Repository<IssuerCredentialEntity>;
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockReturnValue(repository),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: <T>(work: (transactionManager: EntityManager) => Promise<T>): Promise<T> =>
        work(manager),
    } as unknown as DataSource;
    const service = new IssuerCredentialProvisioningService(dataSource, encryption);

    const status = await service.provision({
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      issuerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      issuerRuc: '20123456789',
      environment: 'beta',
      solUsername: 'SOLUSER',
      solPassword: 'sol-password',
      certificatePkcs12Base64: Buffer.from('pkcs12-fixture', 'utf8').toString('base64'),
      certificatePassword: 'certificate-password',
    });

    expect(JSON.stringify(status)).not.toContain('sol-password');
    expect(JSON.stringify(status)).not.toContain('certificate-password');
    expect(status).toEqual(
      expect.objectContaining({ version: 1, active: true, hasCertificate: true }),
    );
    expect(savedEntity).toBeDefined();
    if (!savedEntity) {
      throw new Error('Expected an encrypted credential entity');
    }
    expect(JSON.stringify(savedEntity.solEnvelope)).not.toContain('sol-password');
    const decrypted = encryption.decrypt(
      savedEntity.solEnvelope,
      issuerCredentialEncryptionContext(savedEntity, 'sol'),
    );
    try {
      expect(decrypted.toString('utf8')).toContain('sol-password');
    } finally {
      decrypted.fill(0);
    }
  });
});
