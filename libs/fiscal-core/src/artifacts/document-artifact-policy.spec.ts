import { coreDocumentArtifactObjectKey, sunatDocumentArtifactObjectKey } from '@app/contracts';

import {
  assertStoredDocumentArtifact,
  parseSunatDocumentArtifacts,
} from './document-artifact-policy';

const OWNERSHIP = Object.freeze({
  organizationId: '11111111-1111-4111-8111-111111111111',
  issuerId: '22222222-2222-4222-8222-222222222222',
  documentId: '33333333-3333-4333-8333-333333333333',
});
const OTHER_ORGANIZATION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ISSUER_ID = '55555555-5555-4555-8555-555555555555';
const DIGEST = 'a'.repeat(64);

describe('document artifact policy', () => {
  it('accepts a strict SUNAT artifact bound to the exact document coordinates', () => {
    const artifact = {
      kind: 'signed-xml' as const,
      objectKey: sunatDocumentArtifactObjectKey({
        ...OWNERSHIP,
        kind: 'signed-xml',
        sha256: DIGEST,
      }),
      sha256: DIGEST,
      contentType: 'application/xml',
      sizeBytes: 128,
    };

    expect(parseSunatDocumentArtifacts([artifact], OWNERSHIP)).toEqual([artifact]);
  });

  it('rejects a SUNAT artifact key derived from another issuer', () => {
    const artifact = {
      kind: 'xml',
      objectKey: sunatDocumentArtifactObjectKey({
        ...OWNERSHIP,
        issuerId: OTHER_ISSUER_ID,
        kind: 'xml',
        sha256: DIGEST,
      }),
      sha256: DIGEST,
      contentType: 'application/xml',
      sizeBytes: 128,
    };

    expect(() => parseSunatDocumentArtifacts([artifact], OWNERSHIP)).toThrow(
      'Artifact object key does not belong to the fiscal document',
    );
  });

  it('rejects a persisted Core artifact key derived from another tenant', () => {
    const artifact = {
      kind: 'pdf',
      objectKey: coreDocumentArtifactObjectKey({
        ...OWNERSHIP,
        organizationId: OTHER_ORGANIZATION_ID,
        kind: 'pdf',
        sha256: DIGEST,
      }),
      sha256: DIGEST,
      contentType: 'application/pdf',
      sizeBytes: '128',
    };

    expect(() => assertStoredDocumentArtifact(artifact, OWNERSHIP)).toThrow(
      'Artifact object key does not belong to the fiscal document',
    );
  });
});
