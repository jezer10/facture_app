import type { QueryRunner } from 'typeorm';

import { AddCoreOutboxRetrying1787356860000 } from './202608220002-add-core-outbox-retrying';

describe('AddCoreOutboxRetrying1787356860000', () => {
  it('makes legacy terminal failures immediately retryable', async () => {
    const query = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const migration = new AddCoreOutboxRetrying1787356860000();

    await migration.up({ query } as unknown as QueryRunner);

    const [sql = ''] = query.mock.calls[0] ?? [];
    expect(sql).toContain("'retrying'");
    expect(sql).toContain("SET status = 'retrying'");
    expect(sql).toContain("WHERE status = 'failed'");
    expect(sql).toContain('available_at = now()');
  });
});
