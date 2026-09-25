import type { DataSource } from 'typeorm';

import type { DatabaseSchema, SchemaForeignKey, SchemaTable } from '../models';

interface ColumnRow {
  readonly column_name: unknown;
  readonly table_name: unknown;
}

interface ForeignKeyRow {
  readonly column_name: unknown;
  readonly referenced_column: unknown;
  readonly referenced_table: unknown;
  readonly table_name: unknown;
}

export async function inspectPostgresSchema(
  dataSource: DataSource,
  schemaName: string,
  tableNames: readonly string[],
): Promise<DatabaseSchema> {
  const columns = await dataSource.query<ColumnRow[]>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2::text[])
      ORDER BY table_name, ordinal_position`,
    [schemaName, tableNames],
  );
  const foreignKeys = await dataSource.query<ForeignKeyRow[]>(
    `SELECT tc.table_name,
            kcu.column_name,
            ccu.table_name AS referenced_table,
            ccu.column_name AS referenced_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_catalog = kcu.constraint_catalog
        AND tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_catalog = ccu.constraint_catalog
        AND tc.constraint_schema = ccu.constraint_schema
        AND tc.constraint_name = ccu.constraint_name
      WHERE tc.table_schema = $1
        AND tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = ANY($2::text[])
      ORDER BY tc.table_name, kcu.ordinal_position`,
    [schemaName, tableNames],
  );

  const tableColumns = new Map<string, string[]>();
  for (const row of columns) {
    const table = requiredString(row.table_name);
    const column = requiredString(row.column_name);
    const current = tableColumns.get(table) ?? [];
    current.push(column);
    tableColumns.set(table, current);
  }
  const tableForeignKeys = new Map<string, SchemaForeignKey[]>();
  for (const row of foreignKeys) {
    const table = requiredString(row.table_name);
    const current = tableForeignKeys.get(table) ?? [];
    current.push({
      column: requiredString(row.column_name),
      referencedColumn: requiredString(row.referenced_column),
      referencedTable: requiredString(row.referenced_table),
    });
    tableForeignKeys.set(table, current);
  }

  const tables: SchemaTable[] = [];
  for (const name of tableNames) {
    const actualColumns = tableColumns.get(name);
    if (actualColumns) {
      tables.push({
        columns: actualColumns,
        foreignKeys: tableForeignKeys.get(name) ?? [],
        name,
      });
    }
  }
  return { tables };
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('PostgreSQL schema inspection returned an invalid identifier');
  }
  return value;
}
