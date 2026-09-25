export interface StoredObject {
  readonly key: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
  readonly sha256: string;
}

export interface ObjectStoragePort {
  healthCheck(): Promise<void>;
  putImmutable(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  createReadUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export const OBJECT_STORAGE_PORT = Symbol('OBJECT_STORAGE_PORT');
