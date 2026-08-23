import type { DataSource } from 'typeorm';

import { TypeOrmSubmissionJournalAdapter } from './typeorm-submission-journal.adapter';

describe('TypeOrmSubmissionJournalAdapter', () => {
  const beginInput = {
    commandEventId: 'event-1',
    organizationId: '0198f176-2ca2-7000-8000-000000000001',
    issuerId: '0198f176-2ca2-7000-8000-000000000002',
    identity: {
      documentId: '0198f176-2ca2-7000-8000-000000000003',
      issuerRuc: '20123456789',
      documentType: '01' as const,
      series: 'F001',
      number: '9007199254740993',
    },
    operation: 'issue' as const,
    payloadSha256: 'a'.repeat(64),
  };

  it('reuses the fiscal identity only when its immutable payload hash matches', async () => {
    const query = queryMock()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([submissionRow('a'.repeat(64))]);
    const adapter = new TypeOrmSubmissionJournalAdapter(dataSource(query));

    await expect(adapter.begin(beginInput)).resolves.toEqual(
      expect.objectContaining({
        submissionId: '0198f176-2ca2-7000-8000-000000000004',
        acquired: false,
        status: 'accepted',
      }),
    );
    expect(query.mock.calls[0]?.[1]).toContain('9007199254740993');
  });

  it('rejects the same fiscal identity when it points to different bytes', async () => {
    const query = queryMock()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([submissionRow('b'.repeat(64))]);
    const adapter = new TypeOrmSubmissionJournalAdapter(dataSource(query));

    await expect(adapter.begin(beginInput)).rejects.toMatchObject({
      code: 'SUNAT_PAYLOAD_INTEGRITY_FAILED',
    });
  });

  it('finds a pending submission by opaque provider tracking data', async () => {
    const query = queryMock().mockResolvedValueOnce([
      { id: '0198f176-2ca2-7000-8000-000000000004' },
    ]);
    const adapter = new TypeOrmSubmissionJournalAdapter(dataSource(query));

    await expect(
      adapter.findForReconciliation({
        issuerId: beginInput.issuerId,
        identity: beginInput.identity,
        providerTrackingId: 'ticket-1',
        ticket: 'ticket-1',
      }),
    ).resolves.toEqual({ submissionId: '0198f176-2ca2-7000-8000-000000000004' });
  });
});

type QueryMock = jest.Mock<Promise<unknown>, [string, unknown[]?]>;

function queryMock(): QueryMock {
  return jest.fn<Promise<unknown>, [string, unknown[]?]>();
}

function dataSource(query: QueryMock): DataSource {
  return { query } as unknown as DataSource;
}

function submissionRow(payloadSha256: string): {
  id: string;
  payload_sha256: string;
  status: 'accepted';
  provider_tracking_id: string;
  ticket: null;
  response_code: string;
  response_description: string;
} {
  return {
    id: '0198f176-2ca2-7000-8000-000000000004',
    payload_sha256: payloadSha256,
    status: 'accepted',
    provider_tracking_id: 'tracking-1',
    ticket: null,
    response_code: '0',
    response_description: 'Aceptado',
  };
}
