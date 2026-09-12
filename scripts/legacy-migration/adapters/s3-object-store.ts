import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { ArtifactLocator, ObjectMetadata } from '../models';
import { LegacyMigrationError } from '../models';
import type { ArtifactReaderPort, DestinationObjectStorePort } from '../ports';

export interface R2ConnectionOptions {
  readonly accessKeyId: string;
  readonly bucket: string;
  readonly endpoint: string;
  readonly secretAccessKey: string;
}

export function createR2Client(options: R2ConnectionOptions): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    endpoint: options.endpoint,
    forcePathStyle: true,
    region: 'auto',
  });
}

export class R2LegacyArtifactReaderAdapter implements ArtifactReaderPort {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async read(locator: ArtifactLocator): Promise<Buffer> {
    if (locator.adapter !== 'legacy-r2') {
      throw new LegacyMigrationError(
        'UNSUPPORTED_ARTIFACT_SOURCE',
        'The legacy R2 reader received an unsupported locator',
      );
    }
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: locator.value }),
    );
    if (!response.Body) {
      throw new LegacyMigrationError(
        'SOURCE_ARTIFACT_UNAVAILABLE',
        'The legacy R2 object has no readable body',
      );
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }
}

export class R2DestinationObjectStoreAdapter implements DestinationObjectStorePort {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async head(key: string): Promise<ObjectMetadata | undefined> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (
        response.ContentLength === undefined ||
        !Number.isSafeInteger(response.ContentLength) ||
        response.ContentLength < 0
      ) {
        throw new LegacyMigrationError(
          'INVALID_DESTINATION_OBJECT_METADATA',
          'R2 returned invalid object metadata',
        );
      }
      const sha256 = response.Metadata?.sha256;
      return {
        ...(sha256 ? { sha256 } : {}),
        sizeBytes: response.ContentLength,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async read(key: string): Promise<Buffer | undefined> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return response.Body ? Buffer.from(await response.Body.transformToByteArray()) : undefined;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async putIfAbsent(key: string, body: Buffer, contentType: string, sha256: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Body: body,
          Bucket: this.bucket,
          ContentType: contentType,
          IfNoneMatch: '*',
          Key: key,
          Metadata: { sha256 },
        }),
      );
    } catch (error) {
      if (!isPreconditionConflict(error)) {
        throw error;
      }
    }
  }
}

export class RoutedArtifactReaderAdapter implements ArtifactReaderPort {
  constructor(
    private readonly local: ArtifactReaderPort | undefined,
    private readonly legacyR2: ArtifactReaderPort | undefined,
  ) {}

  read(locator: ArtifactLocator): Promise<Buffer> {
    const reader = locator.adapter === 'local-filesystem' ? this.local : this.legacyR2;
    if (!reader) {
      throw new LegacyMigrationError(
        'ARTIFACT_SOURCE_NOT_CONFIGURED',
        'The requested artifact source is not configured',
      );
    }
    return reader.read(locator);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    errorName(error) === 'NotFound' || errorName(error) === 'NoSuchKey' || httpStatus(error) === 404
  );
}

function isPreconditionConflict(error: unknown): boolean {
  const status = httpStatus(error);
  return errorName(error) === 'PreconditionFailed' || status === 409 || status === 412;
}

function errorName(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === 'string' ? error.name : undefined;
}

function httpStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.$metadata)) {
    return undefined;
  }
  return typeof error.$metadata.httpStatusCode === 'number'
    ? error.$metadata.httpStatusCode
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
