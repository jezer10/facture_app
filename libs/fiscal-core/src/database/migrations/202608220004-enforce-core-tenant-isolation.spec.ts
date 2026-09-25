import type { QueryRunner } from 'typeorm';

import { EnforceCoreTenantIsolation1787356980000 } from './202608220004-enforce-core-tenant-isolation';

describe('EnforceCoreTenantIsolation1787356980000', () => {
  it('preflights legacy tenant mismatches before changing the schema', async () => {
    const query = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const migration = new EnforceCoreTenantIsolation1787356980000();

    await migration.up({ query } as unknown as QueryRunner);

    const [preflight = ''] = query.mock.calls[0] ?? [];
    expect(preflight).toContain('tenant isolation preflight failed: api_keys');
    expect(preflight).toContain('account_row.organization_id <> grant_row.organization_id');
    expect(preflight).toContain('series_row.issuer_id <> document_row.issuer_id');
    expect(preflight).toContain('reference_row.organization_id <> document_row.organization_id');
    expect(preflight).toContain('tenant isolation preflight failed: received sync');
    expect(preflight).toContain('tenant isolation preflight failed: outbox aggregate');
    expect(preflight).not.toContain('ALTER TABLE');
  });

  it('installs and validates composite tenant foreign keys', async () => {
    const query = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const migration = new EnforceCoreTenantIsolation1787356980000();

    await migration.up({ query } as unknown as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('UNIQUE (id, organization_id)');
    expect(sql).toContain('FOREIGN KEY (service_account_id, organization_id)');
    expect(sql).toContain('FOREIGN KEY (issuer_id, organization_id)');
    expect(sql).toContain(
      'FOREIGN KEY (series_id, organization_id, issuer_id, document_type, series)',
    );
    expect(sql).toContain('FOREIGN KEY (reference_document_id, organization_id)');
    expect(sql).toContain('FOREIGN KEY (document_id, organization_id)');
    expect(sql).toContain('FOREIGN KEY (recipient_issuer_id, organization_id)');
    expect(sql).toContain('FOREIGN KEY (received_document_id, organization_id)');
    expect(sql).toContain('ON DELETE CASCADE NOT VALID');
    expect(sql).toContain('ON DELETE RESTRICT NOT VALID');
    expect(sql).toContain('VALIDATE CONSTRAINT fk_fiscal_documents_series_tenant');
    expect(sql).toContain('VALIDATE CONSTRAINT fk_received_documents_issuer_tenant');
  });

  it('derives child tenant columns and rejects mismatched outbox aggregates', async () => {
    const query = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const migration = new EnforceCoreTenantIsolation1787356980000();

    await migration.up({ query } as unknown as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('trg_issuer_series_set_organization');
    expect(sql).toContain('trg_document_artifacts_set_organization');
    expect(sql).toContain('trg_document_state_history_set_organization');
    expect(sql).toContain('trg_received_artifacts_set_organization');
    expect(sql).toContain('trg_outbox_events_enforce_aggregate_tenant');
    expect(sql).toContain('tenant isolation violation: outbox aggregate mismatch');
  });

  it('restores the original single-column relationships on downgrade', async () => {
    const query = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const migration = new EnforceCoreTenantIsolation1787356980000();

    await migration.down({ query } as unknown as QueryRunner);

    const [sql = ''] = query.mock.calls[0] ?? [];
    expect(sql).toContain('ADD CONSTRAINT api_keys_service_account_id_fkey');
    expect(sql).toContain('ADD CONSTRAINT fiscal_documents_series_id_fkey');
    expect(sql).toContain('DROP COLUMN IF EXISTS organization_id');
  });
});
