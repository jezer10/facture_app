import { sha256 } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';

import { SunatPayloadIntegrityError } from '../../domain/errors/sunat.error';
import type {
  StoreSunatArtifactInput,
  StoredSunatArtifact,
  SunatArtifactStorePort,
} from '../../domain/ports/sunat-artifact-store.port';
import type { SunatPayloadStorePort } from '../../domain/ports/sunat-payload-store.port';

export class R2SunatStoreAdapter implements SunatPayloadStorePort, SunatArtifactStorePort {
  constructor(private readonly storage: ObjectStoragePort) {}

  async load(payloadRef: string, expectedSha256: string): Promise<unknown> {
    assertCorePayloadKey(payloadRef);
    const body = await this.storage.get(payloadRef);
    if (sha256(body) !== expectedSha256.toLowerCase()) {
      throw new SunatPayloadIntegrityError();
    }
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new SunatPayloadIntegrityError(
        'El objeto fiscal recuperado de R2 no contiene JSON válido.',
      );
    }
  }

  async store(input: StoreSunatArtifactInput): Promise<StoredSunatArtifact> {
    assertSunatArtifactKey(input.objectKey);
    const body = Buffer.from(input.body);
    const digest = sha256(body);
    const stored = await this.storage.putImmutable({
      key: input.objectKey,
      body,
      contentType: input.contentType,
      sha256: digest,
    });
    if (
      stored.key !== input.objectKey ||
      stored.contentType !== input.contentType ||
      stored.sha256 !== digest ||
      stored.sizeBytes !== body.byteLength
    ) {
      throw new SunatPayloadIntegrityError(
        'R2 no confirmó la integridad del artefacto fiscal almacenado.',
      );
    }
    return {
      kind: input.kind,
      objectKey: stored.key,
      sha256: stored.sha256,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
    };
  }

  async readiness(): Promise<{
    ready: boolean;
    durable: true;
    detail?: string;
  }> {
    try {
      await this.storage.healthCheck();
      return { ready: true, durable: true };
    } catch {
      return {
        ready: false,
        durable: true,
        detail: 'El bucket R2 privado no está disponible.',
      };
    }
  }
}

function assertCorePayloadKey(key: string): void {
  if (!isSafeKey(key) || !key.startsWith('core/')) {
    throw new SunatPayloadIntegrityError(
      'La referencia del payload no pertenece al namespace privado de Core.',
    );
  }
}

function assertSunatArtifactKey(key: string): void {
  if (!isSafeKey(key) || !key.startsWith('sunat/')) {
    throw new SunatPayloadIntegrityError(
      'El artefacto no pertenece al namespace privado de SUNAT.',
    );
  }
}

function isSafeKey(key: string): boolean {
  return Boolean(key) && !key.startsWith('/') && !key.includes('..') && !key.includes('\\');
}
