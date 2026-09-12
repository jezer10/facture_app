import type { SunatResultEnvelope } from '@app/contracts';
import type { DataSource } from 'typeorm';

import type { CompletedSunatCommand } from '../../application/sunat-command-executor';
import { TypeOrmCommandLedgerAdapter } from './typeorm-command-ledger.adapter';

describe('TypeOrmCommandLedgerAdapter', () => {
  it('atomically acquires a command inserted into the durable inbox', async () => {
    const query = queryMock().mockResolvedValueOnce([{ event_id: 'event-1' }]);
    const adapter = new TypeOrmCommandLedgerAdapter(dataSource(query));

    await expect(adapter.reserve('event-1', 1)).resolves.toEqual({ state: 'acquired' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (event_id) DO NOTHING');
  });

  it('returns the stored result instead of executing a duplicate command', async () => {
    const result = completedResult();
    const query = queryMock()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: 'completed', result }]);
    const adapter = new TypeOrmCommandLedgerAdapter(dataSource(query));

    await expect(adapter.reserve('event-1', 1)).resolves.toEqual({
      state: 'completed',
      result,
    });
  });

  it('recovers a stale processing lock without deleting completed entries', async () => {
    const query = queryMock()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ event_id: 'event-1' }]);
    const adapter = new TypeOrmCommandLedgerAdapter(dataSource(query), 60_000);

    await expect(adapter.reserve('event-1', 1)).resolves.toEqual({ state: 'acquired' });
    expect(query.mock.calls[1]?.[1]).toEqual(['event-1', 1, 60_000]);
  });

  it('lets a later BullMQ attempt recover the prior processing lease immediately', async () => {
    const query = queryMock()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ event_id: 'event-1' }]);
    const adapter = new TypeOrmCommandLedgerAdapter(dataSource(query));

    await expect(adapter.reserve('event-1', 2)).resolves.toEqual({ state: 'acquired' });

    expect(query.mock.calls[1]?.[0]).toContain('processing_attempt < $2');
    expect(query.mock.calls[1]?.[1]).toEqual(['event-1', 2, 300_000]);
  });

  it('stages a completed command for durable result delivery', async () => {
    const query = queryMock().mockResolvedValueOnce([{ event_id: 'event-1' }]);
    const adapter = new TypeOrmCommandLedgerAdapter(dataSource(query));
    const result = completedResult();

    await adapter.complete('event-1', result);

    expect(query.mock.calls[0]?.[0]).toContain("delivery_status = 'pending'");
    expect(query.mock.calls[0]?.[1]).toEqual(['event-1', JSON.stringify(result)]);
  });

  it('claims and maps pending deliveries with a lease', async () => {
    const result = completedResult();
    const query = queryMock().mockResolvedValueOnce([
      { event_id: 'event-1', result, delivery_attempts: 2 },
    ]);
    const adapter = new TypeOrmCommandLedgerAdapter(dataSource(query));

    await expect(adapter.claimPendingDeliveries(20, 60_000)).resolves.toEqual([
      { eventId: 'event-1', result, attempt: 2 },
    ]);
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(query.mock.calls[0]?.[1]).toEqual([20, 60_000]);
  });
});

type QueryMock = jest.Mock<Promise<unknown>, [string, unknown[]?]>;

function queryMock(): QueryMock {
  return jest.fn<Promise<unknown>, [string, unknown[]?]>();
}

function dataSource(query: QueryMock): DataSource {
  return { query } as unknown as DataSource;
}

function completedResult(): CompletedSunatCommand {
  const result = {
    eventId: 'result-1',
    type: 'sunat.document.failed.v1',
    version: 1,
    occurredAt: '2026-08-22T00:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'event-1',
    organizationId: 'organization-1',
    issuerId: 'issuer-1',
    payloadRef: 'sunat/results/result-1.json',
    payloadSha256: 'a'.repeat(64),
    payload: {
      documentId: 'document-1',
      code: 'TEST',
      description: 'test',
      retryable: false,
    },
  } as SunatResultEnvelope;
  return { result };
}
