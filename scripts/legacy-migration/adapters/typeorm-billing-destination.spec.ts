import type { DataSource, QueryRunner } from 'typeorm';

import { snapshotHash } from '../canonical-json';
import type { ReceivedDocumentImport } from '../models';
import { TypeormBillingDestinationAdapter } from './typeorm-billing-destination';

describe('TypeormBillingDestinationAdapter', () => {
  it('persists received document metadata atomically under SERIALIZABLE', async () => {
    const document = receivedDocument();
    const runner = new FakeQueryRunner(document);
    const dataSource = {
      createQueryRunner: () => runner as unknown as QueryRunner,
      isInitialized: false,
    } as unknown as DataSource;
    const adapter = new TypeormBillingDestinationAdapter(dataSource);

    await adapter.persist(document);

    expect(runner.connected).toBe(true);
    expect(runner.isolation).toBe('SERIALIZABLE');
    expect(runner.committed).toBe(true);
    expect(runner.rolledBack).toBe(false);
    expect(runner.released).toBe(true);
    expect(
      runner.statements.some((statement) =>
        statement.includes('INSERT INTO "public"."received_documents"'),
      ),
    ).toBe(true);
    expect(
      runner.statements.filter((statement) =>
        statement.includes('INSERT INTO "public"."received_document_artifacts"'),
      ),
    ).toHaveLength(2);
    expect(
      runner.statements.some((statement) =>
        /INSERT INTO "public"\."document_artifacts"/u.test(statement),
      ),
    ).toBe(false);
  });

  it('repairs missing artifact metadata after an interrupted transaction boundary', async () => {
    const document = receivedDocument();
    const runner = new FakeQueryRunner(document);
    runner.seedPartialDestination();
    const dataSource = {
      createQueryRunner: () => runner as unknown as QueryRunner,
      isInitialized: false,
    } as unknown as DataSource;

    await new TypeormBillingDestinationAdapter(dataSource).persist(document);

    expect(
      runner.statements.some((statement) =>
        statement.includes('INSERT INTO "public"."received_documents"'),
      ),
    ).toBe(false);
    expect(
      runner.statements.filter((statement) =>
        statement.includes('INSERT INTO "public"."received_document_artifacts"'),
      ),
    ).toHaveLength(1);
    expect(runner.committed).toBe(true);
  });
});

class FakeQueryRunner {
  committed = false;
  connected = false;
  documentInserted = false;
  isolation: string | undefined;
  released = false;
  rolledBack = false;
  readonly statements: string[] = [];
  private readonly artifactRows: Array<Record<string, unknown>> = [];

  constructor(private readonly document: ReceivedDocumentImport) {}

  seedPartialDestination(): void {
    this.documentInserted = true;
    const artifact = this.document.artifacts[0]!;
    this.artifactRows.push({
      content_type: artifact.contentType,
      created_at: artifact.createdAt,
      kind: artifact.kind,
      object_key: artifact.objectKey,
      sha256: artifact.sha256,
      size_bytes: String(artifact.sizeBytes),
    });
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  startTransaction(isolation: string): Promise<void> {
    this.isolation = isolation;
    return Promise.resolve();
  }

  commitTransaction(): Promise<void> {
    this.committed = true;
    return Promise.resolve();
  }

  rollbackTransaction(): Promise<void> {
    this.rolledBack = true;
    return Promise.resolve();
  }

  release(): Promise<void> {
    this.released = true;
    return Promise.resolve();
  }

  query(statement: string, parameters: readonly unknown[] = []): Promise<unknown> {
    this.statements.push(statement);
    if (statement.includes('INSERT INTO "public"."received_documents"')) {
      this.documentInserted = true;
      return Promise.resolve([]);
    }
    if (statement.includes('INSERT INTO "public"."received_document_artifacts"')) {
      this.artifactRows.push({
        content_type: parameters[4],
        created_at: parameters[6],
        kind: parameters[1],
        object_key: parameters[2],
        sha256: parameters[3],
        size_bytes: parameters[5],
      });
      return Promise.resolve([]);
    }
    if (statement.includes('FROM "public"."received_documents"')) {
      return Promise.resolve(this.documentInserted ? [documentRow(this.document)] : []);
    }
    if (statement.includes('FROM "public"."received_document_artifacts"')) {
      return Promise.resolve([...this.artifactRows]);
    }
    throw new Error('Unexpected test query');
  }
}

function receivedDocument(): ReceivedDocumentImport {
  const snapshot = Object.freeze({ legacy: { importedFrom: 'test', sourceCode: 1 } });
  const createdAt = '2026-08-20T14:30:00.000Z';
  return {
    artifacts: [
      {
        contentType: 'application/json',
        createdAt,
        kind: 'canonical-json',
        objectKey: 'received/id/canonical.json',
        sha256: 'a'.repeat(64),
        sizeBytes: 15,
        source: { adapter: 'legacy-r2', value: 'raw/source' },
      },
      {
        contentType: 'application/pdf',
        createdAt,
        kind: 'pdf',
        objectKey: 'received/id/document.pdf',
        sha256: 'b'.repeat(64),
        sizeBytes: 25,
        source: { adapter: 'legacy-r2', value: 'pdf/source' },
      },
    ],
    createdAt,
    documentType: '01',
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    issueDate: '2026-08-20',
    number: '42',
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    recipientIssuerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    recipientRuc: '20111111111',
    series: 'F001',
    snapshot,
    snapshotSha256: snapshotHash(snapshot),
    source: 'sndr-sunat:1',
    supplierRuc: '20999999999',
  };
}

function documentRow(document: ReceivedDocumentImport): Record<string, unknown> {
  return {
    created_at: document.createdAt,
    document_type: document.documentType,
    id: document.id,
    issue_date: document.issueDate,
    number: document.number,
    organization_id: document.organizationId,
    recipient_issuer_id: document.recipientIssuerId,
    series: document.series,
    snapshot: document.snapshot,
    snapshot_sha256: document.snapshotSha256,
    source: document.source,
    supplier_ruc: document.supplierRuc,
  };
}
