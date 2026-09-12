import type { QueryRunner } from 'typeorm';

import { AddReceivedSyncIdempotency1787356920000 } from './202608220003-add-received-sync-idempotency';

describe('AddReceivedSyncIdempotency1787356920000', () => {
  it('backfills legacy rows before enforcing tenant-and-issuer uniqueness', async () => {
    const statements: string[] = [];
    const query = jest.fn((sql: string): Promise<unknown> => {
      statements.push(sql);
      return Promise.resolve(undefined);
    });
    const migration = new AddReceivedSyncIdempotency1787356920000();

    await migration.up({ query } as unknown as QueryRunner);

    const schema = statements[0] ?? '';
    expect(schema).toContain("idempotency_key = 'legacy:' || id::text");
    expect(schema).toContain('ALTER COLUMN idempotency_key SET NOT NULL');
    expect(schema).toContain('UNIQUE (organization_id, issuer_id, idempotency_key)');
    expect(schema.indexOf('UPDATE received_syncs')).toBeLessThan(
      schema.indexOf('ALTER COLUMN idempotency_key SET NOT NULL'),
    );
  });

  it('removes only the incremental columns when rolled back', async () => {
    const statements: string[] = [];
    const query = jest.fn((sql: string): Promise<unknown> => {
      statements.push(sql);
      return Promise.resolve(undefined);
    });
    const migration = new AddReceivedSyncIdempotency1787356920000();

    await migration.down({ query } as unknown as QueryRunner);

    const schema = statements[0] ?? '';
    expect(schema).toContain('DROP CONSTRAINT IF EXISTS uq_received_syncs_idempotency');
    expect(schema).toContain('DROP COLUMN IF EXISTS request_sha256');
    expect(schema).toContain('DROP COLUMN IF EXISTS idempotency_key');
  });
});
