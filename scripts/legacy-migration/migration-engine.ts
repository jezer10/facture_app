import { inventoryCredentials } from './credential-classifier';
import { sha256Bytes, sha256Text, snapshotHash } from './canonical-json';
import type {
  CandidateArtifact,
  CredentialCategory,
  LegacyCompanyRow,
  LegacyInvoiceRow,
  LocalInvoiceGeneration,
  MigrationMode,
  MigrationReport,
  PreflightDiagnostic,
  QuarantineEntry,
  QuarantineReason,
  ReceivedArtifactImport,
  ReceivedDocumentImport,
  TenantMapping,
} from './models';
import { LegacyMigrationError } from './models';
import type {
  ArtifactReaderPort,
  BillingDestinationPort,
  DestinationObjectStorePort,
  LegacyDatabaseSourcePort,
  LocalInvoiceSourcePort,
  TenantMappingPort,
} from './ports';
import { inspectDestinationSchema, inspectLegacySchema } from './schema-preflight';

interface MigrationEngineDependencies {
  readonly artifactReader: ArtifactReaderPort;
  readonly destination: BillingDestinationPort;
  readonly destinationObjects: DestinationObjectStorePort;
  readonly mapping: TenantMappingPort;
  readonly legacyDatabase?: LegacyDatabaseSourcePort;
  readonly localInvoices?: LocalInvoiceSourcePort;
}

interface MutableReport {
  mode: MigrationMode;
  status: MigrationReport['status'];
  diagnostics: PreflightDiagnostic[];
  sourceDatabase: MigrationReport['preflight']['sourceDatabase'];
  credentialCategories: Record<CredentialCategory, number>;
  accessTokensDiscarded: number;
  discovered: number;
  eligible: number;
  wouldImport: number;
  imported: number;
  alreadyPresent: number;
  conflicts: number;
  quarantined: number;
  verifiedAtSource: number;
  wouldCopy: number;
  copied: number;
  reused: number;
  quarantine: QuarantineEntry[];
}

interface VerifiedArtifact {
  readonly body: Buffer;
  readonly destination: ReceivedArtifactImport;
  readonly destinationState: 'missing' | 'verified';
}

export class LegacyMigrationEngine {
  constructor(private readonly dependencies: MigrationEngineDependencies) {}

  async run(mode: MigrationMode = 'dry-run'): Promise<MigrationReport> {
    const report = emptyReport(mode, this.dependencies.legacyDatabase ? 'inspected' : 'skipped');
    const destinationSchema = await this.dependencies.destination.inspectSchema();
    report.diagnostics.push(...inspectDestinationSchema(destinationSchema));

    if (this.dependencies.legacyDatabase) {
      const sourceSchema = await this.dependencies.legacyDatabase.inspectSchema();
      report.diagnostics.push(...inspectLegacySchema(sourceSchema));
    }
    if (report.diagnostics.length > 0) {
      report.status = 'blocked';
      return finalizeReport(report);
    }

    const companies = this.dependencies.legacyDatabase
      ? await this.dependencies.legacyDatabase.listCompanies()
      : [];
    const credentialInventory = inventoryCredentials(companies);
    report.credentialCategories = { ...credentialInventory.categories };
    report.accessTokensDiscarded = credentialInventory.accessTokensDiscarded;

    const legacyInvoices = this.dependencies.legacyDatabase
      ? await this.dependencies.legacyDatabase.listInvoices()
      : [];
    const localInventory = this.dependencies.localInvoices
      ? await this.dependencies.localInvoices.inventory()
      : { generations: [], quarantine: [] };
    report.quarantine.push(...localInventory.quarantine);
    report.quarantined += localInventory.quarantine.length;
    report.discovered += legacyInvoices.length + localInventory.generations.length;

    const candidates = [
      ...buildDatabaseCandidates(legacyInvoices, companies, this.dependencies.mapping, report),
      ...buildLocalCandidates(localInventory.generations, this.dependencies.mapping, report),
    ];
    report.eligible = candidates.length;

    const mappings = uniqueMappings(candidates);
    let invalidMappings = 0;
    for (const mapping of mappings) {
      if (!(await this.dependencies.destination.validateTenantMapping(mapping))) {
        invalidMappings += 1;
      }
    }
    if (invalidMappings > 0) {
      report.diagnostics.push({ code: 'INVALID_TENANT_MAPPING', count: invalidMappings });
    }
    if (report.diagnostics.length > 0) {
      report.status = 'blocked';
      return finalizeReport(report);
    }

    for (const candidate of candidates) {
      await this.processCandidate(candidate, mode, report);
    }
    return finalizeReport(report);
  }

  private async processCandidate(
    candidate: ReceivedDocumentImport,
    mode: MigrationMode,
    report: MutableReport,
  ): Promise<void> {
    const disposition = await this.dependencies.destination.classify(candidate);
    if (disposition === 'conflict') {
      quarantineCandidate(report, candidate.id, 'DESTINATION_CONFLICT');
      report.conflicts += 1;
      return;
    }

    let verified: readonly VerifiedArtifact[];
    try {
      verified = await this.verifyArtifacts(candidate, report);
    } catch (error) {
      if (error instanceof ArtifactVerificationError) {
        quarantineCandidate(report, candidate.id, error.reason);
        if (error.reason === 'DESTINATION_OBJECT_CONFLICT') {
          report.conflicts += 1;
        }
        return;
      }
      throw error;
    }

    if (
      disposition === 'identical' &&
      verified.every((artifact) => artifact.destinationState === 'verified')
    ) {
      report.alreadyPresent += 1;
      report.reused += verified.length;
      return;
    }

    const missing = verified.filter((artifact) => artifact.destinationState === 'missing');
    if (mode === 'dry-run') {
      report.wouldImport += 1;
      report.wouldCopy += missing.length;
      report.reused += verified.length - missing.length;
      return;
    }

    for (const artifact of missing) {
      await this.dependencies.destinationObjects.putIfAbsent(
        artifact.destination.objectKey,
        artifact.body,
        artifact.destination.contentType,
        artifact.destination.sha256,
      );
      const stored = await this.dependencies.destinationObjects.head(
        artifact.destination.objectKey,
      );
      const storedBody = await this.dependencies.destinationObjects.read(
        artifact.destination.objectKey,
      );
      if (
        !matchesDestination(stored, artifact.destination) ||
        !matchesBody(storedBody, artifact.destination)
      ) {
        throw new LegacyMigrationError(
          'DESTINATION_OBJECT_VERIFICATION_FAILED',
          'Destination artifact verification failed after upload',
        );
      }
      report.copied += 1;
    }
    report.reused += verified.length - missing.length;
    await this.dependencies.destination.persist(candidate);
    report.imported += 1;
  }

  private async verifyArtifacts(
    candidate: ReceivedDocumentImport,
    report: MutableReport,
  ): Promise<readonly VerifiedArtifact[]> {
    const sourceVerified: Array<{ body: Buffer; destination: ReceivedArtifactImport }> = [];
    for (const artifact of candidate.artifacts) {
      let body: Buffer;
      try {
        body = await this.dependencies.artifactReader.read(artifact.source);
      } catch (error) {
        throw new ArtifactVerificationError('SOURCE_ARTIFACT_UNAVAILABLE', { cause: error });
      }
      if (body.byteLength !== artifact.sizeBytes || sha256Bytes(body) !== artifact.sha256) {
        throw new ArtifactVerificationError('SOURCE_ARTIFACT_MISMATCH');
      }
      sourceVerified.push({ body, destination: artifact });
      report.verifiedAtSource += 1;
    }

    const verified: VerifiedArtifact[] = [];
    for (const artifact of sourceVerified) {
      const existing = await this.dependencies.destinationObjects.head(
        artifact.destination.objectKey,
      );
      if (existing && !matchesDestination(existing, artifact.destination)) {
        throw new ArtifactVerificationError('DESTINATION_OBJECT_CONFLICT');
      }
      if (existing) {
        const existingBody = await this.dependencies.destinationObjects.read(
          artifact.destination.objectKey,
        );
        if (!matchesBody(existingBody, artifact.destination)) {
          throw new ArtifactVerificationError('DESTINATION_OBJECT_CONFLICT');
        }
      }
      verified.push({
        ...artifact,
        destinationState: existing ? 'verified' : 'missing',
      });
    }
    return verified;
  }
}

class ArtifactVerificationError extends Error {
  constructor(
    public readonly reason:
      | 'SOURCE_ARTIFACT_UNAVAILABLE'
      | 'SOURCE_ARTIFACT_MISMATCH'
      | 'DESTINATION_OBJECT_CONFLICT',
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = 'ArtifactVerificationError';
  }
}

function buildDatabaseCandidates(
  invoices: readonly LegacyInvoiceRow[],
  companies: readonly LegacyCompanyRow[],
  mappingPort: TenantMappingPort,
  report: MutableReport,
): ReceivedDocumentImport[] {
  const companyById = new Map<string, LegacyCompanyRow>();
  for (const company of companies) {
    if (typeof company.id === 'string') {
      companyById.set(company.id, company);
    }
  }

  const candidates: ReceivedDocumentImport[] = [];
  let missingMappings = 0;
  for (const invoice of invoices) {
    const fingerprint = rowFingerprint(invoice);
    const parsed = parseLegacyInvoice(invoice);
    if (!parsed) {
      report.quarantine.push({ fingerprint, reason: 'INVALID_LEGACY_RECORD' });
      report.quarantined += 1;
      continue;
    }
    if (parsed.status !== 'stored' || parsed.artifacts.length !== 2) {
      report.quarantine.push({ fingerprint, reason: 'INCOMPLETE_LEGACY_RECORD' });
      report.quarantined += 1;
      continue;
    }
    const company = companyById.get(parsed.companyId);
    const recipientRuc =
      company && typeof company.recipientRuc === 'string' ? company.recipientRuc : undefined;
    const mapping = recipientRuc
      ? mappingPort.resolveLegacyCompany(parsed.companyId, recipientRuc)
      : undefined;
    if (!mapping) {
      missingMappings += 1;
      continue;
    }
    candidates.push(toDatabaseImport(parsed, mapping));
  }
  if (missingMappings > 0) {
    report.diagnostics.push({ code: 'MISSING_TENANT_MAPPING', count: missingMappings });
  }
  return candidates;
}

function buildLocalCandidates(
  generations: readonly LocalInvoiceGeneration[],
  mappingPort: TenantMappingPort,
  report: MutableReport,
): ReceivedDocumentImport[] {
  const candidates: ReceivedDocumentImport[] = [];
  let missingMappings = 0;
  for (const generation of generations) {
    const mapping = mappingPort.resolveRecipientRuc(generation.recipientRuc);
    if (!mapping) {
      missingMappings += 1;
      continue;
    }
    const source = `local-sunat:${generation.source}`;
    const snapshot = Object.freeze({
      legacy: {
        importedFrom: 'facture-app-local',
        filesystemCreatedAt: generation.createdAt,
        sourceCode: generation.source,
      },
      payload: generation.snapshot,
    });
    candidates.push({
      artifacts: destinationArtifacts(generation.id, generation.createdAt, generation.artifacts),
      createdAt: generation.createdAt,
      documentType: generation.documentType,
      id: generation.id,
      issueDate: generation.issueDate,
      number: generation.number,
      organizationId: mapping.organizationId,
      recipientIssuerId: mapping.recipientIssuerId,
      recipientRuc: mapping.recipientRuc,
      series: generation.series,
      snapshot,
      snapshotSha256: snapshotHash(snapshot),
      source,
      supplierRuc: generation.supplierRuc,
    });
  }
  if (missingMappings > 0) {
    report.diagnostics.push({ code: 'MISSING_TENANT_MAPPING', count: missingMappings });
  }
  return candidates;
}

interface ParsedLegacyInvoice {
  readonly artifacts: readonly CandidateArtifact[];
  readonly companyId: string;
  readonly createdAt: string;
  readonly currencyCode?: string;
  readonly documentType: string;
  readonly id: string;
  readonly issueDate: string;
  readonly lastSyncedAt?: string;
  readonly number: string;
  readonly series: string;
  readonly source: number;
  readonly status: string;
  readonly supplierRuc: string;
  readonly totalAmount?: string;
  readonly updatedAt: string;
  readonly hadFailureMessage: boolean;
}

function parseLegacyInvoice(row: LegacyInvoiceRow): ParsedLegacyInvoice | undefined {
  const id = text(row.id);
  const companyId = text(row.companyId);
  const supplierRuc = text(row.supplierRuc);
  const documentType = text(row.documentType);
  const series = text(row.series);
  const number = text(row.number);
  const source = integer(row.source);
  const status = text(row.status);
  const issueDate = text(row.issueDate);
  const createdAt = timestamp(row.createdAt);
  const updatedAt = timestamp(row.updatedAt);
  if (
    !id ||
    !isUuid(id) ||
    !companyId ||
    !supplierRuc ||
    !/^\d{11}$/u.test(supplierRuc) ||
    !documentType ||
    !/^[A-Z0-9]{2}$/u.test(documentType) ||
    !series ||
    !/^[A-Z0-9-]{1,4}$/u.test(series) ||
    !number ||
    !/^\d{1,20}$/u.test(number) ||
    source === undefined ||
    !status ||
    !issueDate ||
    !isDate(issueDate) ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }

  const artifacts = parseLegacyArtifacts(row);
  if (!artifacts) {
    return {
      artifacts: [],
      companyId,
      createdAt,
      documentType,
      hadFailureMessage: Boolean(text(row.failureMessage)),
      id,
      issueDate,
      number,
      series,
      source,
      status,
      supplierRuc,
      updatedAt,
    };
  }
  return {
    artifacts,
    companyId,
    createdAt,
    ...(text(row.currencyCode) ? { currencyCode: text(row.currencyCode)! } : {}),
    documentType,
    hadFailureMessage: Boolean(text(row.failureMessage)),
    id,
    issueDate,
    ...(timestamp(row.lastSyncedAt) ? { lastSyncedAt: timestamp(row.lastSyncedAt)! } : {}),
    number,
    series,
    source,
    status,
    supplierRuc,
    ...(text(row.totalAmount) ? { totalAmount: text(row.totalAmount)! } : {}),
    updatedAt,
  };
}

function parseLegacyArtifacts(row: LegacyInvoiceRow): readonly CandidateArtifact[] | undefined {
  const raw = legacyArtifact('canonical-json', row.rawObjectKey, row.rawSha256, row.rawSize);
  const pdf = legacyArtifact('pdf', row.pdfObjectKey, row.pdfSha256, row.pdfSize);
  return raw && pdf ? [raw, pdf] : undefined;
}

function legacyArtifact(
  kind: CandidateArtifact['kind'],
  keyValue: unknown,
  hashValue: unknown,
  sizeValue: unknown,
): CandidateArtifact | undefined {
  const key = text(keyValue);
  const hash = text(hashValue);
  const size = integer(sizeValue);
  if (!key || !hash || !/^[a-f0-9]{64}$/u.test(hash) || size === undefined || size < 0) {
    return undefined;
  }
  return {
    contentType: kind === 'pdf' ? 'application/pdf' : 'application/json',
    expectedSha256: hash,
    expectedSizeBytes: size,
    kind,
    source: { adapter: 'legacy-r2', value: key },
  };
}

function toDatabaseImport(
  invoice: ParsedLegacyInvoice,
  mapping: TenantMapping,
): ReceivedDocumentImport {
  const source = `sndr-sunat:${invoice.source}`;
  const snapshot = Object.freeze({
    currencyCode: invoice.currencyCode ?? null,
    hadFailureMessage: invoice.hadFailureMessage,
    legacy: {
      createdAt: invoice.createdAt,
      importedFrom: 'sndr-back',
      lastSyncedAt: invoice.lastSyncedAt ?? null,
      sourceCode: invoice.source,
      status: invoice.status,
      updatedAt: invoice.updatedAt,
    },
    totalAmount: invoice.totalAmount ?? null,
  });
  return {
    artifacts: destinationArtifacts(invoice.id, invoice.createdAt, invoice.artifacts),
    createdAt: invoice.createdAt,
    documentType: invoice.documentType,
    id: invoice.id,
    issueDate: invoice.issueDate,
    number: invoice.number,
    organizationId: mapping.organizationId,
    recipientIssuerId: mapping.recipientIssuerId,
    recipientRuc: mapping.recipientRuc,
    series: invoice.series,
    snapshot,
    snapshotSha256: snapshotHash(snapshot),
    source,
    supplierRuc: invoice.supplierRuc,
  };
}

function destinationArtifacts(
  documentId: string,
  createdAt: string,
  artifacts: readonly CandidateArtifact[],
): ReceivedArtifactImport[] {
  return artifacts.map((artifact) => {
    const extension = artifact.kind === 'pdf' ? 'pdf' : 'json';
    return {
      contentType: artifact.contentType,
      createdAt,
      kind: artifact.kind,
      objectKey: `received/${documentId}/${artifact.kind}-${artifact.expectedSha256}.${extension}`,
      sha256: artifact.expectedSha256,
      sizeBytes: artifact.expectedSizeBytes,
      source: artifact.source,
    };
  });
}

function uniqueMappings(documents: readonly ReceivedDocumentImport[]): TenantMapping[] {
  const mappings = new Map<string, TenantMapping>();
  for (const document of documents) {
    const key = `${document.organizationId}:${document.recipientIssuerId}`;
    mappings.set(key, {
      organizationId: document.organizationId,
      recipientIssuerId: document.recipientIssuerId,
      recipientRuc: document.recipientRuc,
    });
  }
  return [...mappings.values()];
}

function matchesDestination(
  metadata: { readonly sha256?: string; readonly sizeBytes: number } | undefined,
  artifact: ReceivedArtifactImport,
): boolean {
  return metadata?.sizeBytes === artifact.sizeBytes && metadata.sha256 === artifact.sha256;
}

function matchesBody(body: Buffer | undefined, artifact: ReceivedArtifactImport): boolean {
  return (
    body !== undefined &&
    body.byteLength === artifact.sizeBytes &&
    sha256Bytes(body) === artifact.sha256
  );
}

function quarantineCandidate(report: MutableReport, id: string, reason: QuarantineReason): void {
  report.quarantine.push({ fingerprint: sha256Text(`candidate:${id}`), reason });
  report.quarantined += 1;
}

function rowFingerprint(row: LegacyInvoiceRow): string {
  return sha256Text(`legacy-row:${typeof row.id === 'string' ? row.id : 'invalid'}`);
}

function emptyReport(
  mode: MigrationMode,
  sourceDatabase: MigrationReport['preflight']['sourceDatabase'],
): MutableReport {
  return {
    accessTokensDiscarded: 0,
    alreadyPresent: 0,
    conflicts: 0,
    copied: 0,
    credentialCategories: { corrupt: 0, envelope: 0, plaintext: 0 },
    diagnostics: [],
    discovered: 0,
    eligible: 0,
    imported: 0,
    mode,
    quarantine: [],
    quarantined: 0,
    reused: 0,
    sourceDatabase,
    status: 'completed',
    verifiedAtSource: 0,
    wouldCopy: 0,
    wouldImport: 0,
  };
}

function finalizeReport(report: MutableReport): MigrationReport {
  return Object.freeze({
    artifacts: {
      copied: report.copied,
      reused: report.reused,
      verifiedAtSource: report.verifiedAtSource,
      wouldCopy: report.wouldCopy,
    },
    credentials: {
      accessTokensDiscarded: report.accessTokensDiscarded,
      categories: Object.freeze({ ...report.credentialCategories }),
    },
    documents: {
      alreadyPresent: report.alreadyPresent,
      conflicts: report.conflicts,
      discovered: report.discovered,
      eligible: report.eligible,
      imported: report.imported,
      quarantined: report.quarantined,
      wouldImport: report.wouldImport,
    },
    mode: report.mode,
    preflight: {
      diagnostics: Object.freeze([...report.diagnostics]),
      sourceDatabase: report.sourceDatabase,
    },
    quarantine: Object.freeze([...report.quarantine]),
    safety: { secretsEmitted: false as const, sourceDeletes: 0 as const },
    status: report.status,
    version: 1,
  });
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function timestamp(value: unknown): string | undefined {
  const date =
    value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
