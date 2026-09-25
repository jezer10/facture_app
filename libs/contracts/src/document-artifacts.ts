import type { ArtifactReference } from './event-envelope';

export const SUNAT_DOCUMENT_ARTIFACT_KINDS = ['xml', 'signed-xml', 'zip', 'cdr'] as const;
export type SunatDocumentArtifactKind = (typeof SUNAT_DOCUMENT_ARTIFACT_KINDS)[number];

export const CORE_DOCUMENT_ARTIFACT_KINDS = ['canonical-json', 'pdf'] as const;
export type CoreDocumentArtifactKind = (typeof CORE_DOCUMENT_ARTIFACT_KINDS)[number];

export const DOCUMENT_ARTIFACT_CONTENT_TYPES = Object.freeze({
  'canonical-json': 'application/json',
  xml: 'application/xml',
  'signed-xml': 'application/xml',
  zip: 'application/zip',
  cdr: 'application/zip',
  pdf: 'application/pdf',
} satisfies Readonly<Record<ArtifactReference['kind'], string>>);

interface DocumentArtifactCoordinates {
  readonly organizationId: string;
  readonly issuerId: string;
  readonly documentId: string;
  readonly sha256: string;
}

export function coreDocumentArtifactObjectKey(
  input: DocumentArtifactCoordinates & { readonly kind: CoreDocumentArtifactKind },
): string {
  const basename = input.kind === 'canonical-json' ? 'canonical' : 'pdf';
  const extension = input.kind === 'canonical-json' ? 'json' : 'pdf';
  return `core/${input.organizationId}/${input.issuerId}/documents/${input.documentId}/${basename}-${input.sha256}.${extension}`;
}

export function sunatDocumentArtifactObjectKey(
  input: DocumentArtifactCoordinates & { readonly kind: SunatDocumentArtifactKind },
): string {
  const extension = input.kind === 'xml' || input.kind === 'signed-xml' ? 'xml' : 'zip';
  return `sunat/${input.organizationId}/${input.issuerId}/documents/${input.documentId}/${input.kind}-${input.sha256}.${extension}`;
}
