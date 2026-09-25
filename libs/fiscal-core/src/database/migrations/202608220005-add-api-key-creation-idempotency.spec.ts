import type { QueryRunner } from 'typeorm';

import { AddApiKeyCreationIdempotency1787357040000 } from './202608220005-add-api-key-creation-idempotency';

describe('AddApiKeyCreationIdempotency1787357040000', () => {
  it('binds each idempotency record to one API key in the same tenant and service account', async () => {
    const query = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);

    await new AddApiKeyCreationIdempotency1787357040000().up({
      query,
    } as unknown as QueryRunner);

    const [sql = ''] = query.mock.calls[0] ?? [];
    expect(sql).toContain('UNIQUE (organization_id, idempotency_key)');
    expect(sql).toContain('FOREIGN KEY (service_account_id, organization_id)');
    expect(sql).toContain('FOREIGN KEY (api_key_id, organization_id, service_account_id)');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).toContain("CHECK (request_sha256 ~ '^[a-f0-9]{64}$')");
    expect(sql).toContain('credential_envelope jsonb');
    expect(sql).toContain('replay_expires_at timestamptz NOT NULL');
    expect(sql).toContain('WHERE credential_envelope IS NOT NULL');
  });

  it('removes only its table and supporting parent key on downgrade', async () => {
    const query = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);

    await new AddApiKeyCreationIdempotency1787357040000().down({
      query,
    } as unknown as QueryRunner);

    const [sql = ''] = query.mock.calls[0] ?? [];
    expect(sql).toContain('cannot downgrade API-key idempotency while tombstones exist');
    expect(sql).toContain('DROP TABLE IF EXISTS api_key_creation_requests');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS uq_api_keys_tenant_service_identity');
  });
});
