export const SUNAT_ARTIFACT_STORE_PORT = Symbol('SUNAT_ARTIFACT_STORE_PORT');

export type SunatArtifactKind = 'xml' | 'signed-xml' | 'zip' | 'cdr' | 'canonical-json';

export interface StoredSunatArtifact {
  kind: SunatArtifactKind;
  objectKey: string;
  sha256: string;
  contentType: string;
  sizeBytes: number;
}

export interface StoreSunatArtifactInput {
  kind: SunatArtifactKind;
  objectKey: string;
  contentType: string;
  body: Uint8Array;
}

export interface SunatArtifactStorePort {
  store(input: StoreSunatArtifactInput): Promise<StoredSunatArtifact>;
  readiness(): Promise<{ ready: boolean; durable: boolean; detail?: string }>;
}
