import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStoragePort, PutObjectInput, StoredObject } from './object-storage.port';

export interface R2ObjectStorageOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export class R2ObjectStorage implements ObjectStoragePort {
  private readonly client: S3Client;

  constructor(private readonly options: R2ObjectStorageOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async healthCheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
  }

  async putImmutable(input: PutObjectInput): Promise<StoredObject> {
    try {
      const existing = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: input.key }),
      );
      if (existing.Metadata?.sha256 !== input.sha256) {
        throw new Error(`Immutable object key already exists with different content: ${input.key}`);
      }
      return {
        key: input.key,
        contentType: existing.ContentType ?? input.contentType,
        sizeBytes: existing.ContentLength ?? input.body.length,
        sha256: input.sha256,
      };
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    await this.client
      .send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          Metadata: { sha256: input.sha256 },
          IfNoneMatch: '*',
        }),
      )
      .catch(async (error: unknown) => {
        if (!isPreconditionFailed(error)) {
          throw error;
        }
        const existing = await this.client.send(
          new HeadObjectCommand({ Bucket: this.options.bucket, Key: input.key }),
        );
        if (existing.Metadata?.sha256 !== input.sha256) {
          throw new Error(
            `Immutable object key already exists with different content: ${input.key}`,
          );
        }
      });
    return {
      key: input.key,
      contentType: input.contentType,
      sizeBytes: input.body.length,
      sha256: input.sha256,
    };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error(`Object has no body: ${key}`);
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }

  createReadUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const status =
    '$metadata' in error
      ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
      : undefined;
  const name = 'name' in error ? String(error.name) : '';
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const status =
    '$metadata' in error
      ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
      : undefined;
  const name = 'name' in error ? String(error.name) : '';
  return status === 412 || name === 'PreconditionFailed';
}
