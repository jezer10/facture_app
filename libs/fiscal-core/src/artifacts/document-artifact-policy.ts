import type { ArtifactReference } from '@app/contracts';
import {
  CORE_DOCUMENT_ARTIFACT_KINDS,
  coreDocumentArtifactObjectKey,
  DOCUMENT_ARTIFACT_CONTENT_TYPES,
  SUNAT_DOCUMENT_ARTIFACT_KINDS,
  sunatDocumentArtifactObjectKey,
} from '@app/contracts';
import type { CoreDocumentArtifactKind, SunatDocumentArtifactKind } from '@app/contracts';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ARTIFACT_FIELDS = ['contentType', 'kind', 'objectKey', 'sha256', 'sizeBytes'] as const;
const MAX_ARTIFACTS_PER_RESULT = 8;

export interface DocumentArtifactOwnership {
  readonly organizationId: string;
  readonly issuerId: string;
  readonly documentId: string;
}

export function parseSunatDocumentArtifacts(
  value: unknown,
  ownership: DocumentArtifactOwnership,
): readonly ArtifactReference[] {
  assertOwnership(ownership);
  if (!Array.isArray(value) || value.length > MAX_ARTIFACTS_PER_RESULT) {
    throw invalidArtifact('SUNAT result artifacts must be an array with at most 8 entries');
  }

  const seen = new Set<string>();
  return value.map((candidate) => {
    const artifact = parseArtifact(candidate, ownership, 'sunat');
    const identity = `${artifact.kind}:${artifact.sha256}`;
    if (seen.has(identity)) {
      throw invalidArtifact('SUNAT result contains a duplicate artifact reference');
    }
    seen.add(identity);
    return artifact;
  });
}

export function assertStoredDocumentArtifact(
  value: {
    readonly contentType: unknown;
    readonly kind: unknown;
    readonly objectKey: unknown;
    readonly sha256: unknown;
    readonly sizeBytes: unknown;
  },
  ownership: DocumentArtifactOwnership,
): void {
  assertOwnership(ownership);
  const kind = parseArtifactKind(value.kind);
  parseArtifact(
    {
      contentType: value.contentType,
      kind,
      objectKey: value.objectKey,
      sha256: value.sha256,
      sizeBytes: normalizePersistedSize(value.sizeBytes),
    },
    ownership,
    isSunatKind(kind) ? 'sunat' : 'core',
  );
}

export function parseDocumentArtifactKind(value: unknown): ArtifactReference['kind'] {
  return parseArtifactKind(value);
}

function parseArtifact(
  value: unknown,
  ownership: DocumentArtifactOwnership,
  owner: 'core' | 'sunat',
): ArtifactReference {
  if (!isPlainRecord(value) || !hasExactlyArtifactFields(value)) {
    throw invalidArtifact('Artifact reference must contain only the supported fields');
  }

  const kind = parseArtifactKind(value.kind);
  if ((owner === 'sunat' && !isSunatKind(kind)) || (owner === 'core' && !isCoreKind(kind))) {
    throw invalidArtifact('Artifact kind is not valid for its owning service');
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw invalidArtifact('Artifact SHA-256 must be lowercase hexadecimal');
  }
  if (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0) {
    throw invalidArtifact('Artifact size must be a positive safe integer');
  }
  if (
    typeof value.contentType !== 'string' ||
    value.contentType !== DOCUMENT_ARTIFACT_CONTENT_TYPES[kind]
  ) {
    throw invalidArtifact('Artifact content type does not match its kind');
  }

  const expectedKey =
    owner === 'sunat'
      ? sunatDocumentArtifactObjectKey({
          ...ownership,
          kind: kind as SunatDocumentArtifactKind,
          sha256: value.sha256,
        })
      : coreDocumentArtifactObjectKey({
          ...ownership,
          kind: kind as CoreDocumentArtifactKind,
          sha256: value.sha256,
        });
  if (value.objectKey !== expectedKey) {
    throw invalidArtifact('Artifact object key does not belong to the fiscal document');
  }

  return Object.freeze({
    contentType: value.contentType,
    kind,
    objectKey: expectedKey,
    sha256: value.sha256,
    sizeBytes: Number(value.sizeBytes),
  });
}

function parseArtifactKind(value: unknown): ArtifactReference['kind'] {
  if (typeof value !== 'string' || (!isSunatKind(value) && !isCoreKind(value))) {
    throw invalidArtifact('Artifact kind is unsupported');
  }
  return value;
}

function isSunatKind(value: string): value is SunatDocumentArtifactKind {
  return (SUNAT_DOCUMENT_ARTIFACT_KINDS as readonly string[]).includes(value);
}

function isCoreKind(value: string): value is CoreDocumentArtifactKind {
  return (CORE_DOCUMENT_ARTIFACT_KINDS as readonly string[]).includes(value);
}

function normalizePersistedSize(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw invalidArtifact('Persisted artifact size is invalid');
  }
  return Number(value);
}

function assertOwnership(ownership: DocumentArtifactOwnership): void {
  if (
    !UUID_PATTERN.test(ownership.organizationId) ||
    !UUID_PATTERN.test(ownership.issuerId) ||
    !UUID_PATTERN.test(ownership.documentId)
  ) {
    throw invalidArtifact('Artifact ownership identifiers must be UUIDs');
  }
}

function hasExactlyArtifactFields(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === ARTIFACT_FIELDS.length &&
    ARTIFACT_FIELDS.every((field, index) => keys[index] === field)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}

function invalidArtifact(message: string): Error {
  return new Error(`Invalid document artifact reference: ${message}`);
}
