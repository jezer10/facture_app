import { DataSource, type QueryRunner } from 'typeorm';

import { canonicalJson } from '../canonical-json';
import type {
  DatabaseSchema,
  DestinationDisposition,
  ReceivedArtifactImport,
  ReceivedDocumentImport,
  TenantMapping,
} from '../models';
import { LegacyMigrationError } from '../models';
import type { BillingDestinationPort } from '../ports';
import { inspectPostgresSchema } from './typeorm-schema';

const DESTINATION_TABLES = [
  'issuers',
  'received_documents',
  'received_document_artifacts',
] as const;

interface DocumentRow {
  readonly created_at: unknown;
  readonly document_type: unknown;
  readonly id: unknown;
  readonly issue_date: unknown;
  readonly number: unknown;
  readonly organization_id: unknown;
  readonly recipient_issuer_id: unknown;
  readonly series: unknown;
  readonly snapshot: unknown;
  readonly snapshot_sha256: unknown;
  readonly source: unknown;
  readonly supplier_ruc: unknown;
}

interface ArtifactRow {
  readonly content_type: unknown;
  readonly created_at: unknown;
  readonly kind: unknown;
  readonly object_key: unknown;
  readonly sha256: unknown;
  readonly size_bytes: unknown;
}

interface ExistsRow {
  readonly present: unknown;
}

type SqlExecutor = DataSource | QueryRunner;

export class TypeormBillingDestinationAdapter implements BillingDestinationPort {
  constructor(
    private readonly dataSource: DataSource,
    private readonly schemaName = 'public',
  ) {}

  static async connect(
    url: string,
    schemaName = 'public',
  ): Promise<TypeormBillingDestinationAdapter> {
    const dataSource = new DataSource({
      entities: [],
      logging: false,
      schema: schemaName,
      synchronize: false,
      type: 'postgres',
      url,
    });
    await dataSource.initialize();
    return new TypeormBillingDestinationAdapter(dataSource, schemaName);
  }

  inspectSchema(): Promise<DatabaseSchema> {
    return inspectPostgresSchema(this.dataSource, this.schemaName, DESTINATION_TABLES);
  }

  async validateTenantMapping(mapping: TenantMapping): Promise<boolean> {
    const rows = await this.dataSource.query<ExistsRow[]>(
      `SELECT TRUE AS present
         FROM ${this.table('issuers')}
        WHERE id = $1 AND organization_id = $2 AND ruc = $3
        LIMIT 1`,
      [mapping.recipientIssuerId, mapping.organizationId, mapping.recipientRuc],
    );
    return rows.length === 1 && rows[0]?.present === true;
  }

  classify(document: ReceivedDocumentImport): Promise<DestinationDisposition> {
    return this.classifyWith(this.dataSource, document, false);
  }

  async persist(document: ReceivedDocumentImport): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('SERIALIZABLE');
    try {
      const disposition = await this.classifyWith(runner, document, true);
      if (disposition === 'conflict') {
        throw destinationConflict();
      }
      if (disposition === 'new') {
        await runner.query(
          `INSERT INTO ${this.table('received_documents')} (
             id, organization_id, recipient_issuer_id, supplier_ruc,
             document_type, series, number, source, issue_date,
             snapshot, snapshot_sha256, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
           ON CONFLICT DO NOTHING`,
          documentValues(document),
        );
        const inserted = await this.classifyWith(runner, document, true);
        if (inserted === 'new' || inserted === 'conflict') {
          throw destinationConflict();
        }
      }

      const existing = await this.findArtifacts(runner, document.id, true);
      if (!artifactsCompatible(existing, document.artifacts)) {
        throw destinationConflict();
      }
      for (const artifact of document.artifacts) {
        if (!existing.some((row) => artifactMatches(row, artifact))) {
          await runner.query(
            `INSERT INTO ${this.table('received_document_artifacts')} (
               received_document_id, kind, object_key, sha256,
               content_type, size_bytes, created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (received_document_id, kind, sha256) DO NOTHING`,
            [
              document.id,
              artifact.kind,
              artifact.objectKey,
              artifact.sha256,
              artifact.contentType,
              String(artifact.sizeBytes),
              artifact.createdAt,
            ],
          );
        }
      }
      const persisted = await this.findArtifacts(runner, document.id, true);
      if (
        persisted.length !== document.artifacts.length ||
        !artifactsCompatible(persisted, document.artifacts)
      ) {
        throw destinationConflict();
      }
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      if (error instanceof LegacyMigrationError) {
        throw error;
      }
      throw new LegacyMigrationError(
        'DESTINATION_PERSIST_FAILED',
        'The destination transaction could not persist the received document',
        { cause: error },
      );
    } finally {
      await runner.release();
    }
  }

  async close(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }

  private async classifyWith(
    executor: SqlExecutor,
    document: ReceivedDocumentImport,
    lock: boolean,
  ): Promise<DestinationDisposition> {
    const rows = await queryRows<DocumentRow>(
      executor,
      `SELECT id, organization_id, recipient_issuer_id, supplier_ruc,
              document_type, series, number, source, issue_date,
              snapshot, snapshot_sha256, created_at
         FROM ${this.table('received_documents')}
        WHERE id = $1 OR (
          organization_id = $2 AND recipient_issuer_id = $3 AND supplier_ruc = $4
          AND document_type = $5 AND series = $6 AND number = $7 AND source = $8
        )
        ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
      [
        document.id,
        document.organizationId,
        document.recipientIssuerId,
        document.supplierRuc,
        document.documentType,
        document.series,
        document.number,
        document.source,
      ],
    );
    if (rows.length === 0) {
      return 'new';
    }
    if (rows.length !== 1 || !documentMatches(rows[0]!, document)) {
      return 'conflict';
    }
    const artifacts = await this.findArtifacts(executor, document.id, lock);
    if (!artifactsCompatible(artifacts, document.artifacts)) {
      return 'conflict';
    }
    return artifacts.length === document.artifacts.length ? 'identical' : 'partial';
  }

  private findArtifacts(
    executor: SqlExecutor,
    documentId: string,
    lock: boolean,
  ): Promise<ArtifactRow[]> {
    return queryRows<ArtifactRow>(
      executor,
      `SELECT kind, object_key, sha256, content_type,
              size_bytes::text AS size_bytes, created_at
         FROM ${this.table('received_document_artifacts')}
        WHERE received_document_id = $1
        ORDER BY kind, sha256${lock ? ' FOR UPDATE' : ''}`,
      [documentId],
    );
  }

  private table(name: (typeof DESTINATION_TABLES)[number]): string {
    return `${quoteIdentifier(this.schemaName)}.${quoteIdentifier(name)}`;
  }
}

async function queryRows<T>(
  executor: SqlExecutor,
  statement: string,
  parameters: readonly unknown[],
): Promise<T[]> {
  const result: unknown = await executor.query(statement, [...parameters]);
  if (!Array.isArray(result)) {
    throw new TypeError('PostgreSQL query returned an invalid row set');
  }
  return result as T[];
}

function documentValues(document: ReceivedDocumentImport): unknown[] {
  return [
    document.id,
    document.organizationId,
    document.recipientIssuerId,
    document.supplierRuc,
    document.documentType,
    document.series,
    document.number,
    document.source,
    document.issueDate,
    canonicalJson(document.snapshot),
    document.snapshotSha256,
    document.createdAt,
  ];
}

function documentMatches(row: DocumentRow, document: ReceivedDocumentImport): boolean {
  return (
    row.id === document.id &&
    row.organization_id === document.organizationId &&
    row.recipient_issuer_id === document.recipientIssuerId &&
    row.supplier_ruc === document.supplierRuc &&
    row.document_type === document.documentType &&
    row.series === document.series &&
    row.number === document.number &&
    row.source === document.source &&
    dateText(row.issue_date) === document.issueDate &&
    row.snapshot_sha256 === document.snapshotSha256 &&
    timestampText(row.created_at) === document.createdAt &&
    safeCanonicalJson(row.snapshot) === canonicalJson(document.snapshot)
  );
}

function artifactsCompatible(
  rows: readonly ArtifactRow[],
  expected: readonly ReceivedArtifactImport[],
): boolean {
  return rows.every((row) => expected.some((artifact) => artifactMatches(row, artifact)));
}

function artifactMatches(row: ArtifactRow, artifact: ReceivedArtifactImport): boolean {
  return (
    row.kind === artifact.kind &&
    row.object_key === artifact.objectKey &&
    row.sha256 === artifact.sha256 &&
    row.content_type === artifact.contentType &&
    String(row.size_bytes) === String(artifact.sizeBytes) &&
    timestampText(row.created_at) === artifact.createdAt
  );
}

function safeCanonicalJson(value: unknown): string | undefined {
  try {
    return canonicalJson(value);
  } catch {
    return undefined;
  }
}

function dateText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return value instanceof Date ? value.toISOString().slice(0, 10) : undefined;
}

function timestampText(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function destinationConflict(): LegacyMigrationError {
  return new LegacyMigrationError(
    'DESTINATION_CONFLICT',
    'The destination contains a different record for this legacy identity',
  );
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new TypeError('Invalid PostgreSQL identifier');
  }
  return `"${value}"`;
}
