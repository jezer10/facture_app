export type MigrationMode = 'dry-run' | 'apply';
export type CredentialCategory = 'plaintext' | 'envelope' | 'corrupt';
export type ArtifactKind = 'canonical-json' | 'pdf';

export interface SchemaForeignKey {
  readonly column: string;
  readonly referencedColumn: string;
  readonly referencedTable: string;
}

export interface SchemaTable {
  readonly columns: readonly string[];
  readonly foreignKeys: readonly SchemaForeignKey[];
  readonly name: string;
}

export interface DatabaseSchema {
  readonly tables: readonly SchemaTable[];
}

export interface LegacyCompanyRow {
  readonly id: unknown;
  readonly recipientRuc: unknown;
  readonly companyPassword: unknown;
  readonly clientSecret: unknown;
  /** Cached access token. It is inventoried only as present/absent and never migrated. */
  readonly accessToken: unknown;
}

export interface LegacyInvoiceRow {
  readonly id: unknown;
  readonly companyId: unknown;
  readonly supplierRuc: unknown;
  readonly documentType: unknown;
  readonly series: unknown;
  readonly number: unknown;
  readonly source: unknown;
  readonly status: unknown;
  readonly issueDate: unknown;
  readonly currencyCode: unknown;
  readonly totalAmount: unknown;
  readonly rawObjectKey: unknown;
  readonly rawSha256: unknown;
  readonly rawSize: unknown;
  readonly pdfObjectKey: unknown;
  readonly pdfSha256: unknown;
  readonly pdfSize: unknown;
  readonly failureMessage: unknown;
  readonly lastSyncedAt: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

export interface TenantMapping {
  readonly organizationId: string;
  readonly recipientIssuerId: string;
  readonly recipientRuc: string;
}

export interface ArtifactLocator {
  readonly adapter: 'legacy-r2' | 'local-filesystem';
  readonly value: string;
}

export interface CandidateArtifact {
  readonly contentType: 'application/json' | 'application/pdf';
  readonly expectedSha256: string;
  readonly expectedSizeBytes: number;
  readonly kind: ArtifactKind;
  readonly source: ArtifactLocator;
}

export interface LocalInvoiceGeneration {
  readonly createdAt: string;
  readonly documentType: string;
  readonly id: string;
  readonly issueDate: string;
  readonly number: string;
  readonly recipientRuc: string;
  readonly series: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly source: number;
  readonly supplierRuc: string;
  readonly artifacts: readonly CandidateArtifact[];
}

export interface ReceivedDocumentImport {
  readonly artifacts: readonly ReceivedArtifactImport[];
  readonly createdAt: string;
  readonly documentType: string;
  readonly id: string;
  readonly issueDate: string;
  readonly number: string;
  readonly organizationId: string;
  readonly recipientIssuerId: string;
  /** Used only to validate that the mapped issuer belongs to the tenant and has this RUC. */
  readonly recipientRuc: string;
  readonly series: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly snapshotSha256: string;
  readonly source: string;
  readonly supplierRuc: string;
}

export interface ReceivedArtifactImport {
  readonly contentType: 'application/json' | 'application/pdf';
  readonly createdAt: string;
  readonly kind: ArtifactKind;
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly source: ArtifactLocator;
}

export type DestinationDisposition = 'new' | 'identical' | 'partial' | 'conflict';

export interface ObjectMetadata {
  readonly sha256?: string;
  readonly sizeBytes: number;
}

export type QuarantineReason =
  | 'INCOMPLETE_LEGACY_RECORD'
  | 'INVALID_LEGACY_RECORD'
  | 'SOURCE_ARTIFACT_UNAVAILABLE'
  | 'SOURCE_ARTIFACT_MISMATCH'
  | 'DESTINATION_CONFLICT'
  | 'DESTINATION_OBJECT_CONFLICT'
  | 'INVALID_LOCAL_MANIFEST'
  | 'INVALID_LOCAL_PAYLOAD'
  | 'ORPHAN_LOCAL_ARTIFACT';

export interface QuarantineEntry {
  /** One-way locator useful for comparing repeated reports without exposing an ID or path. */
  readonly fingerprint: string;
  readonly reason: QuarantineReason;
}

export interface PreflightDiagnostic {
  readonly code:
    | 'MISSING_SOURCE_TABLE'
    | 'MISSING_SOURCE_COLUMN'
    | 'MISSING_DESTINATION_TABLE'
    | 'MISSING_DESTINATION_COLUMN'
    | 'INVALID_DESTINATION_FOREIGN_KEY'
    | 'MISSING_TENANT_MAPPING'
    | 'INVALID_TENANT_MAPPING';
  readonly count?: number;
  readonly field?: string;
  readonly table?: string;
}

export interface MigrationReport {
  readonly version: 1;
  readonly mode: MigrationMode;
  readonly status: 'blocked' | 'completed';
  readonly preflight: {
    readonly diagnostics: readonly PreflightDiagnostic[];
    readonly sourceDatabase: 'inspected' | 'skipped';
  };
  readonly credentials: {
    readonly accessTokensDiscarded: number;
    readonly categories: Readonly<Record<CredentialCategory, number>>;
  };
  readonly documents: {
    readonly discovered: number;
    readonly eligible: number;
    readonly wouldImport: number;
    readonly imported: number;
    readonly alreadyPresent: number;
    readonly conflicts: number;
    readonly quarantined: number;
  };
  readonly artifacts: {
    readonly verifiedAtSource: number;
    readonly wouldCopy: number;
    readonly copied: number;
    readonly reused: number;
  };
  readonly quarantine: readonly QuarantineEntry[];
  readonly safety: {
    readonly sourceDeletes: 0;
    readonly secretsEmitted: false;
  };
}

export class LegacyMigrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LegacyMigrationError';
  }
}
