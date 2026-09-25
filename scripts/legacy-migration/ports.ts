import type {
  ArtifactLocator,
  DatabaseSchema,
  DestinationDisposition,
  LegacyCompanyRow,
  LegacyInvoiceRow,
  LocalInvoiceGeneration,
  ObjectMetadata,
  QuarantineEntry,
  ReceivedDocumentImport,
  TenantMapping,
} from './models';

export interface LegacyDatabaseSourcePort {
  inspectSchema(): Promise<DatabaseSchema>;
  listCompanies(): Promise<readonly LegacyCompanyRow[]>;
  listInvoices(): Promise<readonly LegacyInvoiceRow[]>;
  close(): Promise<void>;
}

export interface LocalInvoiceSourcePort {
  inventory(): Promise<{
    readonly generations: readonly LocalInvoiceGeneration[];
    readonly quarantine: readonly QuarantineEntry[];
  }>;
}

export interface TenantMappingPort {
  resolveLegacyCompany(legacyCompanyId: string, recipientRuc: string): TenantMapping | undefined;
  resolveRecipientRuc(recipientRuc: string): TenantMapping | undefined;
}

export interface ArtifactReaderPort {
  read(locator: ArtifactLocator): Promise<Buffer>;
}

export interface DestinationObjectStorePort {
  head(key: string): Promise<ObjectMetadata | undefined>;
  read(key: string): Promise<Buffer | undefined>;
  putIfAbsent(key: string, body: Buffer, contentType: string, sha256: string): Promise<void>;
}

export interface BillingDestinationPort {
  inspectSchema(): Promise<DatabaseSchema>;
  validateTenantMapping(mapping: TenantMapping): Promise<boolean>;
  classify(document: ReceivedDocumentImport): Promise<DestinationDisposition>;
  persist(document: ReceivedDocumentImport): Promise<void>;
  close(): Promise<void>;
}
