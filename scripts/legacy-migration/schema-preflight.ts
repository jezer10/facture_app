import type { DatabaseSchema, PreflightDiagnostic } from './models';

const LEGACY_COLUMNS = Object.freeze({
  companies: ['id', 'companyId', 'companyPassword', 'clientSecret', 'token'],
  invoices: [
    'id',
    'company_id',
    'issuer_ruc',
    'document_type',
    'series',
    'number',
    'source',
    'status',
    'issue_date',
    'currency_code',
    'total_amount',
    'raw_object_key',
    'raw_sha256',
    'raw_size',
    'pdf_object_key',
    'pdf_sha256',
    'pdf_size',
    'failure_message',
    'last_synced_at',
    'created_at',
    'updated_at',
  ],
});

const DESTINATION_COLUMNS = Object.freeze({
  issuers: ['id', 'organization_id', 'ruc'],
  received_documents: [
    'id',
    'organization_id',
    'recipient_issuer_id',
    'supplier_ruc',
    'document_type',
    'series',
    'number',
    'source',
    'issue_date',
    'snapshot',
    'snapshot_sha256',
    'created_at',
  ],
  received_document_artifacts: [
    'id',
    'received_document_id',
    'kind',
    'object_key',
    'sha256',
    'content_type',
    'size_bytes',
    'created_at',
  ],
});

export function inspectLegacySchema(schema: DatabaseSchema): readonly PreflightDiagnostic[] {
  return inspectColumns(schema, LEGACY_COLUMNS, 'SOURCE');
}

export function inspectDestinationSchema(schema: DatabaseSchema): readonly PreflightDiagnostic[] {
  const diagnostics = [...inspectColumns(schema, DESTINATION_COLUMNS, 'DESTINATION')];
  const artifacts = schema.tables.find((table) => table.name === 'received_document_artifacts');
  const validForeignKey = artifacts?.foreignKeys.some(
    (foreignKey) =>
      foreignKey.column === 'received_document_id' &&
      foreignKey.referencedTable === 'received_documents' &&
      foreignKey.referencedColumn === 'id',
  );
  if (artifacts && !validForeignKey) {
    diagnostics.push({
      code: 'INVALID_DESTINATION_FOREIGN_KEY',
      field: 'received_document_id',
      table: 'received_document_artifacts',
    });
  }
  return diagnostics;
}

function inspectColumns(
  schema: DatabaseSchema,
  expected: Readonly<Record<string, readonly string[]>>,
  side: 'SOURCE' | 'DESTINATION',
): PreflightDiagnostic[] {
  const diagnostics: PreflightDiagnostic[] = [];
  for (const [tableName, columns] of Object.entries(expected)) {
    const table = schema.tables.find((candidate) => candidate.name === tableName);
    if (!table) {
      diagnostics.push({
        code: side === 'SOURCE' ? 'MISSING_SOURCE_TABLE' : 'MISSING_DESTINATION_TABLE',
        table: tableName,
      });
      continue;
    }
    const actual = new Set(table.columns);
    for (const column of columns) {
      if (!actual.has(column)) {
        diagnostics.push({
          code: side === 'SOURCE' ? 'MISSING_SOURCE_COLUMN' : 'MISSING_DESTINATION_COLUMN',
          field: column,
          table: tableName,
        });
      }
    }
  }
  return diagnostics;
}
