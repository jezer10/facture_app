import type { Job } from 'bullmq';
import type { DataSource, EntityManager } from 'typeorm';
import type { PdfRenderEnvelope, PublicDocumentStatus } from '@app/contracts';
import { canonicalJson, sha256, type ObjectStoragePort } from '@app/platform';

import {
  DocumentArtifactEntity,
  FiscalDocumentEntity,
  InboxMessageEntity,
} from '../database/entities';
import { PdfArtifactProcessor } from './pdf-artifact.processor';
import type { PdfRendererService } from './pdf-renderer.service';

describe('PdfArtifactProcessor', () => {
  it.each<PublicDocumentStatus>([
    'accepted',
    'accepted_with_observations',
    'void_pending',
    'voided',
  ])('renders the immutable accepted snapshot while the document is %s', async (status) => {
    const document = fiscalDocument(status);
    const harness = processorHarness(document);

    await harness.processor.process(pdfJob(document));

    expect(harness.renderer.render).toHaveBeenCalledWith(
      document.fiscalSnapshot,
      document.snapshotSha256,
    );
    expect(harness.putImmutable).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'application/pdf',
        sha256: sha256(Buffer.from('%PDF-accepted-snapshot')),
      }),
    );
    expect(harness.insertBuilder.into).toHaveBeenCalledWith(DocumentArtifactEntity);
    expect(harness.insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: document.id, kind: 'pdf' }),
    );
  });

  it.each([
    { status: 'rejected' as const, acceptedAt: new Date('2026-08-22T10:00:00.000Z') },
    { status: 'void_pending' as const, acceptedAt: null },
  ])('rejects a document without an accepted fiscal lifecycle ($status)', async (overrides) => {
    const document = fiscalDocument(overrides.status, overrides.acceptedAt);
    const harness = processorHarness(document);

    await expect(harness.processor.process(pdfJob(document))).rejects.toThrow(
      'Only a document with an accepted fiscal snapshot can be rendered',
    );
    expect(harness.renderer.render).not.toHaveBeenCalled();
  });

  it('rejects an event whose hash does not identify the accepted snapshot', async () => {
    const document = fiscalDocument('voided');
    const harness = processorHarness(document);
    const event = pdfJob(document);
    event.data = { ...event.data, payloadSha256: 'f'.repeat(64) };

    await expect(harness.processor.process(event)).rejects.toThrow(
      'PDF request does not match the accepted fiscal snapshot',
    );
    expect(harness.renderer.render).not.toHaveBeenCalled();
  });

  it('rejects a mutated stored snapshot even when the event and row hashes agree', async () => {
    const document = fiscalDocument('void_pending');
    document.fiscalSnapshot = { ...document.fiscalSnapshot, currency: 'USD' };
    const harness = processorHarness(document);

    await expect(harness.processor.process(pdfJob(document))).rejects.toThrow(
      'Stored fiscal snapshot hash does not match its canonical payload',
    );
    expect(harness.renderer.render).not.toHaveBeenCalled();
  });
});

interface ProcessorHarness {
  readonly processor: PdfArtifactProcessor;
  readonly renderer: {
    readonly render: jest.Mock;
  };
  readonly putImmutable: jest.Mock;
  readonly insertBuilder: {
    readonly into: jest.Mock;
    readonly values: jest.Mock;
  };
}

function processorHarness(document: FiscalDocumentEntity): ProcessorHarness {
  const inboxRepository = { existsBy: jest.fn().mockResolvedValue(false) };
  const documentRepository = { findOneBy: jest.fn().mockResolvedValue(document) };
  const insertBuilder = fluentInsertBuilder();
  const manager = {
    createQueryBuilder: jest.fn().mockReturnValue(insertBuilder),
  };
  const dataSource = {
    getRepository: jest.fn((target: unknown) =>
      target === InboxMessageEntity ? inboxRepository : documentRepository,
    ),
    transaction: jest.fn(
      <T>(work: (entityManager: EntityManager) => Promise<T>): Promise<T> =>
        work(manager as unknown as EntityManager),
    ),
  } as unknown as DataSource;
  const pdf = Buffer.from('%PDF-accepted-snapshot');
  const renderer = { render: jest.fn().mockResolvedValue(pdf) };
  const putImmutable = jest.fn().mockImplementation((input: { key: string; sha256: string }) =>
    Promise.resolve({
      key: input.key,
      sha256: input.sha256,
      contentType: 'application/pdf',
      sizeBytes: pdf.byteLength,
    }),
  );
  const storage: ObjectStoragePort = {
    healthCheck: jest.fn().mockResolvedValue(undefined),
    putImmutable,
    get: jest.fn(),
    createReadUrl: jest.fn(),
  };
  return {
    processor: new PdfArtifactProcessor(
      dataSource,
      storage,
      renderer as unknown as PdfRendererService,
    ),
    renderer,
    putImmutable,
    insertBuilder,
  };
}

function fiscalDocument(
  status: PublicDocumentStatus,
  acceptedAt: Date | null = new Date('2026-08-22T10:00:00.000Z'),
): FiscalDocumentEntity {
  const fiscalSnapshot = {
    currency: 'PEN',
    customer: { identityNumber: '20100000001', identityType: '6', legalName: 'Cliente' },
    documentType: '01',
    issueDate: '2026-08-22',
    issuer: { legalName: 'Emisor', ruc: '20131312955' },
    lines: [],
    number: '42',
    series: 'F001',
    totals: { igvAmount: '18.00', payableAmount: '118.00', taxableAmount: '100.00' },
  };
  return Object.assign(new FiscalDocumentEntity(), {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    issuerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
    status,
    acceptedAt,
    fiscalSnapshot,
    snapshotSha256: sha256(canonicalJson(fiscalSnapshot)),
  });
}

function pdfJob(document: FiscalDocumentEntity): Job<PdfRenderEnvelope> {
  return {
    data: {
      eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
      type: 'core.pdf.requested.v1',
      version: 1,
      occurredAt: '2026-08-22T10:00:01.000Z',
      correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
      organizationId: document.organizationId,
      issuerId: document.issuerId,
      payloadRef: `core-db://fiscal-documents/${document.id}/snapshot`,
      payloadSha256: document.snapshotSha256,
      payload: { documentId: document.id },
    },
  } as Job<PdfRenderEnvelope>;
}

function fluentInsertBuilder(): {
  readonly insert: jest.Mock;
  readonly into: jest.Mock;
  readonly values: jest.Mock;
  readonly orIgnore: jest.Mock;
  readonly returning: jest.Mock;
  readonly execute: jest.Mock;
} {
  const builder = {
    insert: jest.fn(),
    into: jest.fn(),
    values: jest.fn(),
    orIgnore: jest.fn(),
    returning: jest.fn(),
    execute: jest.fn().mockResolvedValue({ identifiers: [{ id: 'inserted' }] }),
  };
  for (const method of [
    builder.insert,
    builder.into,
    builder.values,
    builder.orIgnore,
    builder.returning,
  ]) {
    method.mockReturnValue(builder);
  }
  return builder;
}
