import { createHash } from 'node:crypto';
import { compareCanonicalJsonKeys } from '@app/contracts';

import { SunatPayloadIntegrityError } from '../../domain/errors/sunat.error';
import type {
  StoreSunatArtifactInput,
  StoredSunatArtifact,
  SunatArtifactStorePort,
} from '../../domain/ports/sunat-artifact-store.port';
import type { SunatPayloadStorePort } from '../../domain/ports/sunat-payload-store.port';

interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/** Volatile object store used only by tests and the opt-in mock runtime. */
export class InMemorySunatStoreAdapter implements SunatPayloadStorePort, SunatArtifactStorePort {
  private readonly objects = new Map<string, StoredObject>();

  seedJson(payloadRef: string, value: unknown): { payloadRef: string; sha256: string } {
    const body = Buffer.from(stableJson(value), 'utf8');
    this.objects.set(payloadRef, {
      body,
      contentType: 'application/json',
    });
    return { payloadRef, sha256: sha256(body) };
  }

  load(payloadRef: string, expectedSha256: string): Promise<unknown> {
    const stored = this.objects.get(payloadRef);
    if (!stored || stored.contentType !== 'application/json') {
      return Promise.reject(
        new SunatPayloadIntegrityError(
          'No existe el payload fiscal JSON indicado por la referencia opaca.',
        ),
      );
    }
    if (sha256(stored.body) !== expectedSha256.toLowerCase()) {
      return Promise.reject(new SunatPayloadIntegrityError());
    }
    try {
      return Promise.resolve(JSON.parse(Buffer.from(stored.body).toString('utf8')) as unknown);
    } catch {
      return Promise.reject(
        new SunatPayloadIntegrityError('El payload fiscal almacenado no contiene JSON válido.'),
      );
    }
  }

  store(input: StoreSunatArtifactInput): Promise<StoredSunatArtifact> {
    assertSafeObjectKey(input.objectKey);
    const body = Uint8Array.from(input.body);
    this.objects.set(input.objectKey, {
      body,
      contentType: input.contentType,
    });
    return Promise.resolve({
      kind: input.kind,
      objectKey: input.objectKey,
      sha256: sha256(body),
      contentType: input.contentType,
      sizeBytes: body.byteLength,
    });
  }

  readiness(): Promise<{
    ready: true;
    durable: false;
    detail: string;
  }> {
    return Promise.resolve({
      ready: true,
      durable: false,
      detail: 'Almacenamiento volátil; sólo apto para mock y pruebas.',
    });
  }
}

function assertSafeObjectKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) {
    throw new SunatPayloadIntegrityError('La clave del artefacto no es segura.');
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCanonicalJsonKeys(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
