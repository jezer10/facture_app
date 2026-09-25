import { coreDocumentArtifactObjectKey } from '@app/contracts';
import type { ObjectStoragePort } from '@app/platform';
import type { DataSource, Repository } from 'typeorm';

import type { HumanPrincipal } from '../auth';
import { DocumentArtifactEntity, FiscalDocumentEntity } from '../database/entities';
import { DocumentArtifactsService } from './document-artifacts.service';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const ISSUER_ID = '33333333-3333-4333-8333-333333333333';
const DOCUMENT_ID = '44444444-4444-4444-8444-444444444444';
const DIGEST = 'b'.repeat(64);

const PRINCIPAL: HumanPrincipal = {
  kind: 'human',
  subject: 'admin@example.test',
  organizationId: ORGANIZATION_ID,
  role: 'admin',
  platformAdmin: false,
};

describe('DocumentArtifactsService', () => {
  it('does not sign a persisted object key owned by another tenant', async () => {
    const document = Object.assign(new FiscalDocumentEntity(), {
      id: DOCUMENT_ID,
      organizationId: ORGANIZATION_ID,
      issuerId: ISSUER_ID,
    });
    const artifact = Object.assign(new DocumentArtifactEntity(), {
      documentId: DOCUMENT_ID,
      kind: 'pdf' as const,
      objectKey: coreDocumentArtifactObjectKey({
        organizationId: OTHER_ORGANIZATION_ID,
        issuerId: ISSUER_ID,
        documentId: DOCUMENT_ID,
        kind: 'pdf',
        sha256: DIGEST,
      }),
      sha256: DIGEST,
      contentType: 'application/pdf',
      sizeBytes: '128',
    });
    const createReadUrl = jest.fn();
    const service = new DocumentArtifactsService(
      dataSource(document, artifact),
      objectStorage(createReadUrl),
    );

    await expect(service.createSignedUrl(PRINCIPAL, DOCUMENT_ID, 'pdf')).rejects.toThrow(
      'Artifact object key does not belong to the fiscal document',
    );
    expect(createReadUrl).not.toHaveBeenCalled();
  });
});

function dataSource(document: FiscalDocumentEntity, artifact: DocumentArtifactEntity): DataSource {
  const documentRepository = {
    findOneBy: jest.fn().mockResolvedValue(document),
  } as unknown as Repository<FiscalDocumentEntity>;
  const artifactRepository = {
    findOne: jest.fn().mockResolvedValue(artifact),
  } as unknown as Repository<DocumentArtifactEntity>;
  return {
    getRepository: (target: unknown) =>
      target === FiscalDocumentEntity ? documentRepository : artifactRepository,
  } as unknown as DataSource;
}

function objectStorage(createReadUrl: jest.Mock): ObjectStoragePort {
  return {
    healthCheck: jest.fn(),
    putImmutable: jest.fn(),
    get: jest.fn(),
    createReadUrl,
  };
}
