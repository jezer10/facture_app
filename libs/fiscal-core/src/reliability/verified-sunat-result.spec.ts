import type { SunatResultEnvelope } from '@app/contracts';
import { canonicalJson, sha256, type ObjectStoragePort } from '@app/platform';

import { verifyStoredSunatResult } from './verified-sunat-result';

describe('verifyStoredSunatResult', () => {
  it('accepts an inline payload only when the immutable R2 bytes and digest match', async () => {
    const result = resultFixture();
    const body = Buffer.from(canonicalJson(result.payload), 'utf8');
    const storage = objectStorage(body);

    await expect(
      verifyStoredSunatResult(storage, { ...result, payloadSha256: sha256(body) }),
    ).resolves.toBeUndefined();
  });

  it('rejects a valid stored payload when the inline queue payload was changed', async () => {
    const result = resultFixture();
    const body = Buffer.from(canonicalJson(result.payload), 'utf8');
    const changed = {
      ...result,
      payloadSha256: sha256(body),
      payload: { ...result.payload, observationCodes: ['QUEUE-TAMPERED'] },
    } as SunatResultEnvelope;

    await expect(verifyStoredSunatResult(objectStorage(body), changed)).rejects.toThrow('differs');
  });

  it('rejects a mismatched digest and references outside sunat/results', async () => {
    const result = resultFixture();
    const body = Buffer.from(canonicalJson(result.payload), 'utf8');

    await expect(verifyStoredSunatResult(objectStorage(body), result)).rejects.toThrow(
      'hash mismatch',
    );
    await expect(
      verifyStoredSunatResult(objectStorage(body), {
        ...result,
        payloadRef: 'core/documents/result.json',
        payloadSha256: sha256(body),
      }),
    ).rejects.toThrow('namespace');
  });
});

function resultFixture(): Extract<SunatResultEnvelope, { type: 'sunat.document.accepted.v1' }> {
  return {
    eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    type: 'sunat.document.accepted.v1',
    version: 1,
    occurredAt: '2026-08-22T00:00:00.000Z',
    correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    issuerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    payloadRef: 'sunat/results/org/issuer/result.json',
    payloadSha256: '0'.repeat(64),
    payload: {
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
      submissionId: 'mock-submission',
      acceptedAt: '2026-08-22T00:00:00.000Z',
      observationCodes: ['MOCK_ONLY'],
      artifacts: [],
    },
  };
}

function objectStorage(body: Buffer): ObjectStoragePort {
  return {
    healthCheck: jest.fn().mockResolvedValue(undefined),
    putImmutable: jest.fn(),
    get: jest.fn().mockResolvedValue(body),
    createReadUrl: jest.fn(),
  };
}
