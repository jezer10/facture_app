import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { ObjectStoragePort } from '@app/platform';
import type { BillingPrincipal } from '../auth';
import {
  ReceivedDocumentEntity,
  ReceivedDocumentArtifactEntity,
  ServiceAccountIssuerGrantEntity,
} from '../database/entities';
import { ReceivedDocumentsService } from './received-documents.service';
import { ReceivedArtifactsService } from './received-artifacts.service';

jest.mock('@app/platform', () => ({
  ...jest.requireActual<Record<string, unknown>>('@app/platform'),
  parseEnvironment: () => ({ R2_SIGNED_URL_TTL_SECONDS: 300 }),
}));

const org = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const issuer = '33333333-3333-4333-8333-333333333333';
const hash = 'a'.repeat(64);
const principal: BillingPrincipal = {
  kind: 'service',
  organizationId: org,
  serviceAccountId: 'account',
  apiKeyId: 'key',
  scopes: new Set(['received:read']),
};

interface ArtifactHarness {
  documents: { findOneBy: jest.Mock };
  artifacts: { findOne: jest.Mock };
  grants: { existsBy: jest.Mock };
  artifact: Pick<
    ReceivedDocumentArtifactEntity,
    | 'organizationId'
    | 'receivedDocumentId'
    | 'kind'
    | 'sha256'
    | 'sizeBytes'
    | 'contentType'
    | 'objectKey'
  >;
  createReadUrl: jest.Mock;
  service: ReceivedArtifactsService;
}

function harness(kind = 'pdf'): ArtifactHarness {
  const document = { id, organizationId: org, recipientIssuerId: issuer };
  const artifact = {
    organizationId: org,
    receivedDocumentId: id,
    kind,
    sha256: hash,
    sizeBytes: '123',
    contentType: kind === 'pdf' ? 'application/pdf' : 'application/json',
    objectKey: `received/${id}/${kind}-${hash}.${kind === 'pdf' ? 'pdf' : 'json'}`,
  };
  const documents = { findOneBy: jest.fn().mockResolvedValue(document) };
  const artifacts = { findOne: jest.fn().mockResolvedValue(artifact) };
  const grants = { existsBy: jest.fn().mockResolvedValue(true) };
  const source = {
    getRepository: (entity: unknown) => {
      if (entity === ReceivedDocumentEntity) return documents;
      if (entity === ReceivedDocumentArtifactEntity) return artifacts;
      if (entity === ServiceAccountIssuerGrantEntity) return grants;
      throw new Error('Unexpected repository');
    },
  } as unknown as DataSource;
  const createReadUrl = jest.fn().mockResolvedValue('https://private.example.test/signed');
  const storage = { createReadUrl } as unknown as ObjectStoragePort;
  return {
    documents,
    artifacts,
    grants,
    artifact,
    createReadUrl,
    service: new ReceivedArtifactsService(new ReceivedDocumentsService(source), source, storage),
  };
}

describe('received artifact access after legacy migration', () => {
  it.each(['pdf', 'canonical-json', 'source'])(
    'signs an authorized migrated %s artifact',
    async (requested) => {
      const kind = requested === 'source' ? 'canonical-json' : requested;
      const h = harness(kind);
      await expect(h.service.createSignedUrl(principal, id, requested)).resolves.toEqual({
        url: 'https://private.example.test/signed',
        expiresInSeconds: 300,
      });
      expect(h.documents.findOneBy).toHaveBeenCalledWith({ id, organizationId: org });
      expect(h.grants.existsBy).toHaveBeenCalledWith({
        organizationId: org,
        serviceAccountId: 'account',
        issuerId: issuer,
      });
      expect(h.artifacts.findOne).toHaveBeenCalledWith({
        where: { organizationId: org, receivedDocumentId: id, kind },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      expect(h.createReadUrl).toHaveBeenCalledWith(h.artifact.objectKey, 300);
    },
  );

  it('does not look up artifacts for a document outside the organization', async () => {
    const h = harness();
    h.documents.findOneBy.mockResolvedValue(null);
    await expect(h.service.createSignedUrl(principal, id, 'pdf')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.artifacts.findOne).not.toHaveBeenCalled();
    expect(h.createReadUrl).not.toHaveBeenCalled();
  });

  it('does not sign after an issuer grant is revoked', async () => {
    const h = harness();
    h.grants.existsBy.mockResolvedValue(false);
    await expect(h.service.createSignedUrl(principal, id, 'pdf')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.artifacts.findOne).not.toHaveBeenCalled();
    expect(h.createReadUrl).not.toHaveBeenCalled();
  });

  it('returns unavailable when no artifact was imported', async () => {
    const h = harness();
    h.artifacts.findOne.mockResolvedValue(null);
    await expect(h.service.createSignedUrl(principal, id, 'pdf')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.createReadUrl).not.toHaveBeenCalled();
  });

  it.each([
    { objectKey: `received/another-document/pdf-${hash}.pdf` },
    { sha256: 'invalid' },
    { contentType: 'text/html' },
    { sizeBytes: '0' },
  ])('rejects corrupt or foreign object metadata: %j', async (patch) => {
    const h = harness();
    Object.assign(h.artifact, patch);
    await expect(h.service.createSignedUrl(principal, id, 'pdf')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.createReadUrl).not.toHaveBeenCalled();
  });

  it('rejects unknown kinds before any lookup', async () => {
    const h = harness();
    await expect(h.service.createSignedUrl(principal, id, '../../secret')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.documents.findOneBy).not.toHaveBeenCalled();
    expect(h.createReadUrl).not.toHaveBeenCalled();
  });
});
