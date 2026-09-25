import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import { R2DestinationObjectStoreAdapter, R2LegacyArtifactReaderAdapter } from './s3-object-store';

describe('R2 migration adapters', () => {
  it('uploads conditionally with a SHA and reads back bytes for independent verification', async () => {
    const body = Buffer.from('verified-object');
    const commands: unknown[] = [];
    const responses: unknown[] = [
      {},
      {
        ContentLength: body.byteLength,
        Metadata: { sha256: 'a'.repeat(64) },
      },
      {
        Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from(body)) },
      },
    ];
    const send = jest.fn((command: unknown): Promise<unknown> => {
      commands.push(command);
      return Promise.resolve(responses.shift());
    });
    const adapter = new R2DestinationObjectStoreAdapter(
      { send } as unknown as S3Client,
      'destination-bucket',
    );

    await adapter.putIfAbsent('received/id/pdf.pdf', body, 'application/pdf', 'a'.repeat(64));
    const metadata = await adapter.head('received/id/pdf.pdf');
    const stored = await adapter.read('received/id/pdf.pdf');

    const [putCommand, headCommand, getCommand] = commands;
    expect(putCommand).toBeInstanceOf(PutObjectCommand);
    expect(headCommand).toBeInstanceOf(HeadObjectCommand);
    expect(getCommand).toBeInstanceOf(GetObjectCommand);
    if (!(putCommand instanceof PutObjectCommand)) {
      throw new Error('Expected a PutObjectCommand');
    }
    expect(putCommand.input).toMatchObject({
      Bucket: 'destination-bucket',
      IfNoneMatch: '*',
      Metadata: { sha256: 'a'.repeat(64) },
    });
    expect(metadata).toEqual({ sha256: 'a'.repeat(64), sizeBytes: body.byteLength });
    expect(stored).toEqual(body);
  });

  it('treats missing destination objects safely and reads legacy objects without mutation', async () => {
    const missingSend = jest
      .fn<Promise<unknown>, [unknown]>()
      .mockRejectedValue({ $metadata: { httpStatusCode: 404 }, name: 'NotFound' });
    const destination = new R2DestinationObjectStoreAdapter(
      { send: missingSend } as unknown as S3Client,
      'destination-bucket',
    );
    await expect(destination.head('missing')).resolves.toBeUndefined();
    await expect(destination.read('missing')).resolves.toBeUndefined();

    const body = Buffer.from('legacy');
    const legacySend = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({
      Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from(body)) },
    });
    const legacy = new R2LegacyArtifactReaderAdapter(
      { send: legacySend } as unknown as S3Client,
      'legacy-bucket',
    );
    await expect(
      legacy.read({ adapter: 'legacy-r2', value: 'immutable/source/key' }),
    ).resolves.toEqual(body);
    expect(legacySend).toHaveBeenCalledTimes(1);
  });
});
