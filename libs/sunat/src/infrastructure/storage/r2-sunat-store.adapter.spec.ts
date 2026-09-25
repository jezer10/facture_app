import {
  sha256,
  type ObjectStoragePort,
  type PutObjectInput,
  type StoredObject,
} from '@app/platform';

import { SunatPayloadIntegrityError } from '../../domain/errors/sunat.error';
import { R2SunatStoreAdapter } from './r2-sunat-store.adapter';

describe('R2SunatStoreAdapter', () => {
  it('loads only Core payloads whose bytes match the command digest', async () => {
    const body = Buffer.from('{"documentId":"document-1"}\n', 'utf8');
    const storage = objectStorage({ get: jest.fn().mockResolvedValue(body) });
    const adapter = new R2SunatStoreAdapter(storage);

    await expect(adapter.load('core/org/issuer/document.json', sha256(body))).resolves.toEqual({
      documentId: 'document-1',
    });
    await expect(
      adapter.load('core/org/issuer/document.json', '0'.repeat(64)),
    ).rejects.toBeInstanceOf(SunatPayloadIntegrityError);
    await expect(adapter.load('sunat/results/result.json', sha256(body))).rejects.toBeInstanceOf(
      SunatPayloadIntegrityError,
    );
  });

  it('writes immutable SUNAT artifacts and verifies the storage acknowledgement', async () => {
    const body = Buffer.from('<Invoice/>', 'utf8');
    const putImmutable = jest.fn(
      (input: PutObjectInput): Promise<StoredObject> =>
        Promise.resolve({
          key: input.key,
          contentType: input.contentType,
          sizeBytes: input.body.byteLength,
          sha256: input.sha256,
        }),
    );
    const storage = objectStorage({ putImmutable });
    const adapter = new R2SunatStoreAdapter(storage);

    await expect(
      adapter.store({
        kind: 'signed-xml',
        objectKey: 'sunat/signed-xml/document.xml',
        contentType: 'application/xml',
        body,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ sha256: sha256(body), sizeBytes: body.byteLength }),
    );
    expect(putImmutable).toHaveBeenCalledWith(expect.objectContaining({ sha256: sha256(body) }));
  });
});

function objectStorage(overrides: Partial<ObjectStoragePort> = {}): ObjectStoragePort {
  return {
    healthCheck: jest.fn().mockResolvedValue(undefined),
    putImmutable: jest.fn(),
    get: jest.fn(),
    createReadUrl: jest.fn(),
    ...overrides,
  };
}
