import { DataSource } from 'typeorm';

import type { DatabaseSchema, LegacyCompanyRow, LegacyInvoiceRow } from '../models';
import type { LegacyDatabaseSourcePort } from '../ports';
import { inspectPostgresSchema } from './typeorm-schema';

const LEGACY_TABLES = ['companies', 'invoices'] as const;

export class TypeormLegacyDatabaseSourceAdapter implements LegacyDatabaseSourcePort {
  constructor(
    private readonly dataSource: DataSource,
    private readonly schemaName = 'public',
  ) {}

  static async connect(
    url: string,
    schemaName = 'public',
  ): Promise<TypeormLegacyDatabaseSourceAdapter> {
    const dataSource = new DataSource({
      entities: [],
      logging: false,
      schema: schemaName,
      synchronize: false,
      type: 'postgres',
      url,
    });
    await dataSource.initialize();
    return new TypeormLegacyDatabaseSourceAdapter(dataSource, schemaName);
  }

  inspectSchema(): Promise<DatabaseSchema> {
    return inspectPostgresSchema(this.dataSource, this.schemaName, LEGACY_TABLES);
  }

  listCompanies(): Promise<readonly LegacyCompanyRow[]> {
    return this.dataSource.query<LegacyCompanyRow[]>(
      `SELECT id,
              "companyId" AS "recipientRuc",
              "companyPassword" AS "companyPassword",
              "clientSecret" AS "clientSecret",
              token AS "accessToken"
         FROM ${quoteIdentifier(this.schemaName)}.companies
        ORDER BY id`,
    );
  }

  listInvoices(): Promise<readonly LegacyInvoiceRow[]> {
    return this.dataSource.query<LegacyInvoiceRow[]>(
      `SELECT id,
              company_id AS "companyId",
              issuer_ruc AS "supplierRuc",
              document_type AS "documentType",
              series,
              number,
              source,
              status,
              issue_date AS "issueDate",
              currency_code AS "currencyCode",
              total_amount AS "totalAmount",
              raw_object_key AS "rawObjectKey",
              raw_sha256 AS "rawSha256",
              raw_size AS "rawSize",
              pdf_object_key AS "pdfObjectKey",
              pdf_sha256 AS "pdfSha256",
              pdf_size AS "pdfSize",
              failure_message AS "failureMessage",
              last_synced_at AS "lastSyncedAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
         FROM ${quoteIdentifier(this.schemaName)}.invoices
        ORDER BY created_at, id`,
    );
  }

  async close(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new TypeError('Invalid PostgreSQL schema identifier');
  }
  return `"${value}"`;
}
