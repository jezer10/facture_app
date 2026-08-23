import type { SunatCommandEnvelope } from '@app/contracts';

import { SunatCommandExecutor, type CompletedSunatCommand } from './sunat-command-executor';
import { SunatProviderTransientError } from '../domain/errors/sunat.error';
import type { ReceivedDocumentDescriptor } from '../domain/models/fiscal-document';
import { MockIssuerCredentialAdapter } from '../infrastructure/mock/mock-issuer-credential.adapter';
import { MockSunatProviderAdapter } from '../infrastructure/mock/mock-sunat-provider.adapter';
import { InMemoryCommandLedgerAdapter } from '../infrastructure/persistence/in-memory-command-ledger.adapter';
import { InMemorySubmissionJournalAdapter } from '../infrastructure/persistence/in-memory-submission-journal.adapter';
import { MockOnlyXmlSignerAdapter } from '../infrastructure/signing/mock-only-xml-signer.adapter';
import { InMemorySunatStoreAdapter } from '../infrastructure/storage/in-memory-sunat-store.adapter';
import { DeterministicUblBuilder } from '../infrastructure/ubl/deterministic-ubl-builder';
import { issueCommandFixture, TEST_NOW } from '../testing/sunat-test-fixtures';

const EXECUTION_CONTEXT = {
  attempt: 1,
  maxAttempts: 3,
  retryDelayMs: 30_000,
};

describe('SunatCommandExecutor', () => {
  it('emits an accepted mock result and reuses it for duplicate commands', async () => {
    const fixture = createExecutor();
    const command = issueCommandFixture(fixture.store);
    const submit = jest.spyOn(fixture.provider, 'submitDocument');

    const first = await fixture.executor.execute(command, EXECUTION_CONTEXT);
    const duplicate = await fixture.executor.execute(command, EXECUTION_CONTEXT);

    expect(first.kind).toBe('completed');
    expect(duplicate).toEqual(first);
    expect(submit).toHaveBeenCalledTimes(1);
    if (first.kind === 'completed') {
      expect(first.output.result.type).toBe('sunat.document.accepted.v1');
      expect(first.output.result.payloadRef).toMatch(/^sunat\/results\//);
      expect(first.output.result.payloadSha256).toHaveLength(64);
      expect(first.output.result.payload).toEqual(
        expect.objectContaining({
          documentId: 'document-1',
          observationCodes: ['MOCK_ONLY'],
        }),
      );
    }
  });

  it('does not resubmit the same fiscal identity when a producer repeats it with a new event id', async () => {
    const fixture = createExecutor();
    const command = issueCommandFixture(fixture.store);
    const submit = jest.spyOn(fixture.provider, 'submitDocument');

    await fixture.executor.execute(command, EXECUTION_CONTEXT);
    const repeated = await fixture.executor.execute(
      { ...command, eventId: 'event-issue-repeated' },
      EXECUTION_CONTEXT,
    );

    expect(repeated.kind).toBe('completed');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('reconciles an ambiguous timeout without submitting the document twice', async () => {
    const fixture = createExecutor('ambiguous_after_accept');
    const command = issueCommandFixture(fixture.store);
    const submit = jest.spyOn(fixture.provider, 'submitDocument');

    const ambiguous = await fixture.executor.execute(command, EXECUTION_CONTEXT);
    expect(ambiguous.kind).toBe('completed');
    if (ambiguous.kind !== 'completed' || !ambiguous.output.followUp) {
      throw new Error('Expected a reconciliation command');
    }
    expect(ambiguous.output.result.type).toBe('sunat.document.reconciling.v1');

    const reconciled = await fixture.executor.execute(ambiguous.output.followUp, EXECUTION_CONTEXT);

    expect(reconciled.kind).toBe('completed');
    if (reconciled.kind === 'completed') {
      expect(reconciled.output.result.type).toBe('sunat.document.accepted.v1');
    }
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('retries transient errors and emits a terminal typed failure when exhausted', async () => {
    const fixture = createExecutor();
    const command = issueCommandFixture(fixture.store);
    jest
      .spyOn(fixture.provider, 'submitDocument')
      .mockRejectedValue(new SunatProviderTransientError());

    const retry = await fixture.executor.execute(command, EXECUTION_CONTEXT);
    const failed = await fixture.executor.execute(command, {
      ...EXECUTION_CONTEXT,
      attempt: 3,
    });

    expect(retry).toEqual(expect.objectContaining({ kind: 'retry' }));
    expect(failed.kind).toBe('completed');
    if (failed.kind === 'completed') {
      expect(failed.output.result.type).toBe('sunat.document.failed.v1');
      expect(failed.output.result.payload).toEqual(
        expect.objectContaining({
          code: 'SUNAT_PROVIDER_UNAVAILABLE_RETRIES_EXHAUSTED',
          retryable: false,
        }),
      );
    }
  });

  it('rejects secret-looking fields before calling any provider', async () => {
    const fixture = createExecutor();
    const command = issueCommandFixture(fixture.store);
    const unsafe = {
      ...command,
      payload: { ...command.payload, clientSecret: 'must-not-enter-redis' },
    } as unknown as SunatCommandEnvelope;
    const submit = jest.spyOn(fixture.provider, 'submitDocument');
    const reserve = jest.spyOn(fixture.ledger, 'reserve');
    const complete = jest.spyOn(fixture.ledger, 'complete');

    const result = await fixture.executor.execute(unsafe, EXECUTION_CONTEXT);

    expect(submit).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledWith(command.eventId, EXECUTION_CONTEXT.attempt);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.output.result.payload).toEqual(
        expect.objectContaining({ code: 'SUNAT_SECRET_IN_COMMAND' }),
      );
    }
  });

  it('does not complete a ledger row when the command lacks a reservable identity', async () => {
    const fixture = createExecutor();
    const command = {
      ...issueCommandFixture(fixture.store),
      eventId: '',
    } as SunatCommandEnvelope;
    const reserve = jest.spyOn(fixture.ledger, 'reserve');
    const complete = jest.spyOn(fixture.ledger, 'complete');

    await expect(fixture.executor.execute(command, EXECUTION_CONTEXT)).rejects.toMatchObject({
      code: 'SUNAT_INVALID_COMMAND',
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('voids a document deterministically through the explicit communication port', async () => {
    const fixture = createExecutor();
    const issue = issueCommandFixture(fixture.store);
    const command: Extract<SunatCommandEnvelope, { type: 'sunat.document.void.requested.v1' }> = {
      ...issue,
      eventId: 'event-void-1',
      type: 'sunat.document.void.requested.v1',
      payload: { ...issue.payload, reason: 'Error en los datos' },
    };

    const result = await fixture.executor.execute(command, EXECUTION_CONTEXT);

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.output.result.type).toBe('sunat.document.voided.v1');
      expect(result.output.result.payload).toEqual(
        expect.objectContaining({ documentId: 'document-1' }),
      );
    }
  });

  it('stores a deduplicated received-document record set by opaque reference', async () => {
    const record: ReceivedDocumentDescriptor = {
      sourceId: '20111111111-01-F001-1-2',
      supplierRuc: '20111111111',
      documentType: '01',
      series: 'F001',
      number: '1',
      source: '2',
      issueDate: '2026-08-20',
      snapshot: { total: '10.00' },
      snapshotSha256: 'a'.repeat(64),
    };
    const fixture = createExecutor('accept', [record, record]);
    const command = receivedSyncCommandFixture(fixture.store);

    const result = await fixture.executor.execute(command, EXECUTION_CONTEXT);

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') {
      return;
    }
    expect(result.output.result.type).toBe('sunat.received.sync.completed.v1');
    if (result.output.result.type !== 'sunat.received.sync.completed.v1') {
      return;
    }
    expect(result.output.result.payload.importedCount).toBe(1);
    const records = await fixture.store.load(
      result.output.result.payload.recordsRef,
      result.output.result.payload.recordsSha256,
    );
    expect(records).toEqual([record]);
  });

  it('emits the received-sync failure contract when credentials are unavailable', async () => {
    const fixture = createExecutor('accept', [], []);
    const command = receivedSyncCommandFixture(fixture.store);

    const result = await fixture.executor.execute(command, EXECUTION_CONTEXT);

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') {
      return;
    }
    expect(result.output.result.type).toBe('sunat.received.sync.failed.v1');
    if (result.output.result.type !== 'sunat.received.sync.failed.v1') {
      return;
    }
    expect(result.output.result.payload).toEqual({
      syncId: 'sync-1',
      code: 'SUNAT_CREDENTIAL_UNAVAILABLE',
      description: 'El emisor no está habilitado en el proveedor SUNAT mock.',
      retryable: false,
    });
    expect(result.output.result.payload).not.toHaveProperty('documentId');
  });
});

interface ExecutorFixture {
  executor: SunatCommandExecutor;
  ledger: InMemoryCommandLedgerAdapter<CompletedSunatCommand>;
  provider: MockSunatProviderAdapter;
  store: InMemorySunatStoreAdapter;
}

function createExecutor(
  submissionBehavior: 'accept' | 'ambiguous_after_accept' = 'accept',
  receivedDocuments: readonly ReceivedDocumentDescriptor[] = [],
  credentialIssuerIds: readonly string[] = ['issuer-1'],
): ExecutorFixture {
  const store = new InMemorySunatStoreAdapter();
  const provider = new MockSunatProviderAdapter({
    submissionBehavior,
    receivedDocuments,
  });
  const credentials = new MockIssuerCredentialAdapter(credentialIssuerIds);
  const ledger = new InMemoryCommandLedgerAdapter<CompletedSunatCommand>();
  const executor = new SunatCommandExecutor({
    provider,
    signer: new MockOnlyXmlSignerAdapter(),
    ublBuilder: new DeterministicUblBuilder(),
    credentials,
    payloadStore: store,
    artifactStore: store,
    ledger,
    submissionJournal: new InMemorySubmissionJournalAdapter(),
    now: () => new Date(TEST_NOW),
  });
  return { executor, ledger, provider, store };
}

function receivedSyncCommandFixture(
  store: InMemorySunatStoreAdapter,
): Extract<SunatCommandEnvelope, { type: 'sunat.received.sync.requested.v1' }> {
  const stored = store.seedJson('memory://core/sync-1', {
    syncId: 'sync-1',
    dateFrom: '2026-08-20',
    dateTo: '2026-08-21',
    documentTypes: ['01'],
    source: '2',
  });
  return {
    eventId: 'event-sync-1',
    type: 'sunat.received.sync.requested.v1',
    version: 1,
    occurredAt: TEST_NOW.toISOString(),
    correlationId: 'correlation-sync-1',
    organizationId: 'organization-1',
    issuerId: 'issuer-1',
    payloadRef: stored.payloadRef,
    payloadSha256: stored.sha256,
    payload: {
      syncId: 'sync-1',
      startDate: '2026-08-20',
      endDate: '2026-08-21',
      documentTypes: ['01'],
    },
  };
}
