import type { DatabaseSchema } from './models';
import { inspectDestinationSchema, inspectLegacySchema } from './schema-preflight';

describe('migration schema preflight', () => {
  it('requires the received artifact table to reference received documents', () => {
    const schema = destinationSchema();
    const artifacts = schema.tables.find((table) => table.name === 'received_document_artifacts')!;
    const invalid: DatabaseSchema = {
      tables: schema.tables.map((table) =>
        table === artifacts ? { ...table, foreignKeys: [] } : table,
      ),
    };

    expect(inspectDestinationSchema(invalid)).toContainEqual({
      code: 'INVALID_DESTINATION_FOREIGN_KEY',
      field: 'received_document_id',
      table: 'received_document_artifacts',
    });
  });

  it('reports unknown source schemas precisely instead of guessing', () => {
    const invalid: DatabaseSchema = {
      tables: [{ columns: ['id'], foreignKeys: [], name: 'companies' }],
    };

    const diagnostics = inspectLegacySchema(invalid);

    expect(diagnostics).toContainEqual({
      code: 'MISSING_SOURCE_TABLE',
      table: 'invoices',
    });
    expect(diagnostics).toContainEqual({
      code: 'MISSING_SOURCE_COLUMN',
      field: 'companyId',
      table: 'companies',
    });
  });
});

function destinationSchema(): DatabaseSchema {
  return {
    tables: [
      {
        columns: ['id', 'organization_id', 'ruc'],
        foreignKeys: [],
        name: 'issuers',
      },
      {
        columns: [
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
        foreignKeys: [],
        name: 'received_documents',
      },
      {
        columns: [
          'id',
          'received_document_id',
          'kind',
          'object_key',
          'sha256',
          'content_type',
          'size_bytes',
          'created_at',
        ],
        foreignKeys: [
          {
            column: 'received_document_id',
            referencedColumn: 'id',
            referencedTable: 'received_documents',
          },
        ],
        name: 'received_document_artifacts',
      },
    ],
  };
}
