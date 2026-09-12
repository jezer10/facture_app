import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import type { PdfRenderEnvelope, PublicDocumentStatus } from '@app/contracts';
import { coreDocumentArtifactObjectKey, CORE_ARTIFACTS_QUEUE } from '@app/contracts';
import { OBJECT_STORAGE_PORT, sha256 } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';
import {
  DocumentArtifactEntity,
  FiscalDocumentEntity,
  InboxMessageEntity,
} from '../database/entities';
import { canonicalFiscalSnapshotArtifact } from '../reliability/canonical-fiscal-snapshot';
import { PdfRendererService } from './pdf-renderer.service';

const PDF_CONSUMER = 'billing-core.pdf.v1';
const PDF_ELIGIBLE_STATUSES: ReadonlySet<PublicDocumentStatus> = new Set([
  'accepted',
  'accepted_with_observations',
  'void_pending',
  'voided',
]);

@Processor(CORE_ARTIFACTS_QUEUE, { concurrency: 1 })
export class PdfArtifactProcessor extends WorkerHost {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
    private readonly renderer: PdfRendererService,
  ) {
    super();
  }

  async process(job: Job<PdfRenderEnvelope>): Promise<void> {
    const event = job.data;
    if (
      await this.dataSource.getRepository(InboxMessageEntity).existsBy({
        consumer: PDF_CONSUMER,
        eventId: event.eventId,
      })
    ) {
      return;
    }
    const document = await this.dataSource.getRepository(FiscalDocumentEntity).findOneBy({
      id: event.payload.documentId,
      organizationId: event.organizationId,
      issuerId: event.issuerId,
    });
    if (!document || !document.acceptedAt || !PDF_ELIGIBLE_STATUSES.has(document.status)) {
      throw new Error('Only a document with an accepted fiscal snapshot can be rendered');
    }
    const expectedPayloadRef = `core-db://fiscal-documents/${document.id}/snapshot`;
    if (
      event.payloadRef !== expectedPayloadRef ||
      event.payloadSha256 !== document.snapshotSha256
    ) {
      throw new Error('PDF request does not match the accepted fiscal snapshot');
    }
    canonicalFiscalSnapshotArtifact(document.fiscalSnapshot, document.snapshotSha256);

    const pdf = await this.renderer.render(document.fiscalSnapshot, document.snapshotSha256);
    const digest = sha256(pdf);
    const key = coreDocumentArtifactObjectKey({
      organizationId: document.organizationId,
      issuerId: document.issuerId,
      documentId: document.id,
      kind: 'pdf',
      sha256: digest,
    });
    const stored = await this.storage.putImmutable({
      key,
      body: pdf,
      contentType: 'application/pdf',
      sha256: digest,
    });

    await this.dataSource.transaction(async (manager) => {
      const claimed = await manager
        .createQueryBuilder()
        .insert()
        .into(InboxMessageEntity)
        .values({ consumer: PDF_CONSUMER, eventId: event.eventId })
        .orIgnore()
        .returning(['id'])
        .execute();
      if (claimed.identifiers.length === 0) {
        return;
      }
      await manager
        .createQueryBuilder()
        .insert()
        .into(DocumentArtifactEntity)
        .values({
          documentId: document.id,
          kind: 'pdf',
          objectKey: stored.key,
          sha256: stored.sha256,
          contentType: stored.contentType,
          sizeBytes: String(stored.sizeBytes),
        })
        .orIgnore()
        .execute();
    });
  }
}
