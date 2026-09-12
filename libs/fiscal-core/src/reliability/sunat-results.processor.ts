import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import type {
  ArtifactReference,
  PublicDocumentStatus,
  ReceivedDocumentRecord,
  SunatResultEnvelope,
  WebhookEventType,
} from '@app/contracts';
import { SUNAT_RESULTS_QUEUE } from '@app/contracts';
import { assertDocumentStatusTransition, isEligibleNoteReferenceStatus } from '@app/fiscal-domain';
import { canonicalJson, OBJECT_STORAGE_PORT, sha256 } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';
import {
  DocumentArtifactEntity,
  DocumentStateHistoryEntity,
  FiscalDocumentEntity,
  InboxMessageEntity,
  OutboxEventEntity,
  ReceivedSyncEntity,
} from '../database/entities';
import { parseSunatDocumentArtifacts } from '../artifacts/document-artifact-policy';
import { verifyStoredSunatResult } from './verified-sunat-result';
import { enqueueWebhookEvent } from './webhook-outbox';

const CONSUMER_NAME = 'billing-core.sunat-results.v1';

@Injectable()
@Processor(SUNAT_RESULTS_QUEUE, { concurrency: 5 })
export class SunatResultsProcessor extends WorkerHost {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {
    super();
  }

  async process(job: Job<SunatResultEnvelope>): Promise<void> {
    const result = job.data;
    await verifyStoredSunatResult(this.storage, result);
    if (result.type === 'sunat.received.sync.completed.v1') {
      const records = await this.loadReceivedRecords(
        result.payload.recordsRef,
        result.payload.recordsSha256,
      );
      await this.dataSource.transaction((manager) =>
        this.applyReceivedSync(manager, result, records),
      );
      return;
    }
    if (result.type === 'sunat.received.sync.failed.v1') {
      await this.dataSource.transaction((manager) =>
        this.applyReceivedSyncFailure(manager, result),
      );
      return;
    }
    await this.dataSource.transaction((manager) => this.applyDocumentResult(manager, result));
  }

  private async applyDocumentResult(
    manager: EntityManager,
    result: Exclude<
      SunatResultEnvelope,
      { type: 'sunat.received.sync.completed.v1' | 'sunat.received.sync.failed.v1' }
    >,
  ): Promise<void> {
    if (!(await claimInbox(manager, result.eventId))) {
      return;
    }
    const document = await manager.findOne(FiscalDocumentEntity, {
      where: { id: result.payload.documentId, organizationId: result.organizationId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!document) {
      throw new Error('SUNAT result references an unknown fiscal document');
    }
    if (document.issuerId !== result.issuerId) {
      throw new Error('SUNAT result issuer does not match the fiscal document');
    }

    if (result.type === 'sunat.document.reconciling.v1') {
      await this.ensureProcessing(manager, document, result);
      return;
    }

    let nextStatus: PublicDocumentStatus;
    let artifacts: readonly ArtifactReference[] = [];
    let reason: string;
    let restoredAfterVoidFailure = false;
    switch (result.type) {
      case 'sunat.document.accepted.v1':
        nextStatus =
          result.payload.observationCodes.length > 0 ? 'accepted_with_observations' : 'accepted';
        artifacts = parseSunatDocumentArtifacts(result.payload.artifacts, {
          organizationId: result.organizationId,
          issuerId: result.issuerId,
          documentId: result.payload.documentId,
        });
        reason = 'sunat-accepted';
        break;
      case 'sunat.document.rejected.v1':
        if (document.status === 'void_pending') {
          nextStatus = await this.statusBeforeVoidRequest(manager, document.id);
          restoredAfterVoidFailure = true;
          reason = `void-rejected:${result.payload.code}`;
        } else {
          nextStatus = 'rejected';
          reason = `sunat-rejected:${result.payload.code}`;
        }
        artifacts = parseSunatDocumentArtifacts(result.payload.artifacts, {
          organizationId: result.organizationId,
          issuerId: result.issuerId,
          documentId: result.payload.documentId,
        });
        break;
      case 'sunat.document.failed.v1':
        if (document.status === 'void_pending') {
          nextStatus = await this.statusBeforeVoidRequest(manager, document.id);
          restoredAfterVoidFailure = true;
          reason = `void-failed:${result.payload.code}`;
        } else {
          nextStatus = 'failed';
          reason = `sunat-failed:${result.payload.code}`;
        }
        break;
      case 'sunat.document.voided.v1':
        nextStatus = 'voided';
        artifacts = parseSunatDocumentArtifacts(result.payload.artifacts, {
          organizationId: result.organizationId,
          issuerId: result.issuerId,
          documentId: result.payload.documentId,
        });
        reason = 'sunat-voided';
        break;
    }

    if (
      (nextStatus === 'accepted' ||
        nextStatus === 'accepted_with_observations' ||
        nextStatus === 'rejected') &&
      document.status === 'queued'
    ) {
      await this.ensureProcessing(manager, document, result);
    }
    const previous = document.status;
    assertDocumentStatusTransition(previous, nextStatus);
    document.status = nextStatus;
    if (
      !restoredAfterVoidFailure &&
      (nextStatus === 'accepted' || nextStatus === 'accepted_with_observations')
    ) {
      document.acceptedAt = new Date();
    }
    if (nextStatus === 'voided') {
      document.voidedAt = new Date();
    }
    await manager.save(document);
    await manager.save(
      manager.create(DocumentStateHistoryEntity, {
        documentId: document.id,
        fromStatus: previous,
        toStatus: nextStatus,
        reason,
        metadata: { sourceEventId: result.eventId },
      }),
    );
    await this.storeArtifactReferences(manager, document.id, artifacts);
    if (
      !restoredAfterVoidFailure &&
      (nextStatus === 'accepted' || nextStatus === 'accepted_with_observations')
    ) {
      await this.createPdfOutbox(manager, document, result);
    }
    await this.createWebhookOutbox(manager, document, result, nextStatus);
  }

  private async statusBeforeVoidRequest(
    manager: EntityManager,
    documentId: string,
  ): Promise<'accepted' | 'accepted_with_observations'> {
    const requestTransition = await manager.findOne(DocumentStateHistoryEntity, {
      where: {
        documentId,
        reason: 'void_requested',
        toStatus: 'void_pending',
      },
      order: { createdAt: 'DESC' },
    });
    const previousStatus = requestTransition?.fromStatus;
    if (!previousStatus || !isEligibleNoteReferenceStatus(previousStatus)) {
      throw new Error('Void result cannot restore the document without its request transition');
    }
    return previousStatus;
  }

  private async ensureProcessing(
    manager: EntityManager,
    document: FiscalDocumentEntity,
    source: Pick<SunatResultEnvelope, 'correlationId' | 'eventId'>,
  ): Promise<void> {
    if (document.status !== 'queued') {
      return;
    }
    assertDocumentStatusTransition('queued', 'processing');
    document.status = 'processing';
    await manager.save(document);
    await manager.save(
      manager.create(DocumentStateHistoryEntity, {
        documentId: document.id,
        fromStatus: 'queued',
        toStatus: 'processing',
        reason: 'sunat-processing',
        metadata: { sourceEventId: source.eventId },
      }),
    );
    await enqueueWebhookEvent(manager, {
      aggregateId: document.id,
      correlationId: source.correlationId,
      eventType: 'fiscal-document.processing.v1',
      issuerId: document.issuerId,
      organizationId: document.organizationId,
      publicStatus: 'processing',
      resourceType: 'fiscal-document',
    });
  }

  private async storeArtifactReferences(
    manager: EntityManager,
    documentId: string,
    artifacts: readonly ArtifactReference[],
  ): Promise<void> {
    for (const artifact of artifacts) {
      await manager
        .createQueryBuilder()
        .insert()
        .into(DocumentArtifactEntity)
        .values({
          documentId,
          kind: artifact.kind,
          objectKey: artifact.objectKey,
          sha256: artifact.sha256,
          contentType: artifact.contentType,
          sizeBytes: String(artifact.sizeBytes),
        })
        .orIgnore()
        .execute();
    }
  }

  private async createWebhookOutbox(
    manager: EntityManager,
    document: FiscalDocumentEntity,
    result: SunatResultEnvelope,
    status: PublicDocumentStatus,
  ): Promise<void> {
    const typeByStatus: Partial<Record<PublicDocumentStatus, WebhookEventType>> = {
      accepted: 'fiscal-document.accepted.v1',
      accepted_with_observations: 'fiscal-document.accepted.v1',
      rejected: 'fiscal-document.rejected.v1',
      failed: 'fiscal-document.failed.v1',
      voided: 'fiscal-document.voided.v1',
    };
    const webhookType = typeByStatus[status];
    if (!webhookType) {
      return;
    }
    await enqueueWebhookEvent(manager, {
      aggregateId: document.id,
      correlationId: result.correlationId,
      eventType: webhookType,
      issuerId: document.issuerId,
      organizationId: document.organizationId,
      publicStatus: status,
      resourceType: 'fiscal-document',
    });
  }

  private async createPdfOutbox(
    manager: EntityManager,
    document: FiscalDocumentEntity,
    result: SunatResultEnvelope,
  ): Promise<void> {
    await manager.save(
      manager.create(OutboxEventEntity, {
        eventId: randomUUID(),
        aggregateType: 'fiscal-document',
        aggregateId: document.id,
        eventType: 'core.pdf.requested.v1',
        organizationId: document.organizationId,
        issuerId: document.issuerId,
        correlationId: result.correlationId,
        payload: {
          payloadRef: `core-db://fiscal-documents/${document.id}/snapshot`,
          payloadSha256: document.snapshotSha256,
        },
        status: 'pending',
        attempts: 0,
        availableAt: new Date(),
        lockedUntil: null,
        lastErrorCode: null,
      }),
    );
  }

  private async loadReceivedRecords(
    ref: string,
    expectedSha256: string,
  ): Promise<ReceivedDocumentRecord[]> {
    const body = await this.storage.get(ref);
    if (sha256(body) !== expectedSha256) {
      throw new Error('Received document batch hash mismatch');
    }
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error('Received document batch must be an array');
    }
    return parsed as ReceivedDocumentRecord[];
  }

  private async applyReceivedSync(
    manager: EntityManager,
    result: Extract<SunatResultEnvelope, { type: 'sunat.received.sync.completed.v1' }>,
    records: readonly ReceivedDocumentRecord[],
  ): Promise<void> {
    if (!(await claimInbox(manager, result.eventId))) {
      return;
    }
    const sync = await manager.findOne(ReceivedSyncEntity, {
      where: { id: result.payload.syncId, organizationId: result.organizationId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!sync || sync.issuerId !== result.issuerId) {
      throw new Error('SUNAT result references an unknown received-document sync');
    }
    for (const record of records) {
      if (sha256(canonicalJson(record.snapshot)) !== record.snapshotSha256) {
        throw new Error('Received document snapshot hash mismatch');
      }
      const inserted: unknown = await manager.query(
        `INSERT INTO received_documents
          (organization_id, recipient_issuer_id, supplier_ruc, document_type, series, number,
           source, issue_date, snapshot, snapshot_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT
          (organization_id, recipient_issuer_id, supplier_ruc, document_type, series, number, source)
         DO NOTHING
         RETURNING id`,
        [
          sync.organizationId,
          sync.issuerId,
          record.supplierRuc,
          record.documentType,
          record.series,
          record.number,
          record.source,
          record.issueDate,
          canonicalJson(record.snapshot),
          record.snapshotSha256,
        ],
      );
      const receivedDocumentId = insertedReceivedDocumentId(inserted);
      if (receivedDocumentId) {
        await enqueueWebhookEvent(manager, {
          aggregateId: receivedDocumentId,
          correlationId: result.correlationId,
          eventType: 'received-document.imported.v1',
          issuerId: sync.issuerId,
          organizationId: sync.organizationId,
          publicStatus: 'imported',
          resourceType: 'received-document',
        });
      }
    }
    sync.status = 'completed';
    sync.resultSummary = {
      importedCount: result.payload.importedCount,
      skippedCount: result.payload.skippedCount,
      failedCount: result.payload.failedCount,
    };
    await manager.save(sync);
  }

  private async applyReceivedSyncFailure(
    manager: EntityManager,
    result: Extract<SunatResultEnvelope, { type: 'sunat.received.sync.failed.v1' }>,
  ): Promise<void> {
    if (!(await claimInbox(manager, result.eventId))) {
      return;
    }
    const sync = await manager.findOne(ReceivedSyncEntity, {
      where: { id: result.payload.syncId, organizationId: result.organizationId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!sync || sync.issuerId !== result.issuerId) {
      throw new Error('SUNAT result references an unknown received-document sync');
    }
    sync.status = 'failed';
    sync.resultSummary = {
      errorCode: result.payload.code,
      errorDescription: result.payload.description,
    };
    await manager.save(sync);
  }
}

function insertedReceivedDocumentId(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const first: unknown = value[0];
  if (
    typeof first !== 'object' ||
    first === null ||
    !('id' in first) ||
    typeof (first as { id?: unknown }).id !== 'string'
  ) {
    throw new Error('Received document insert returned an invalid identifier');
  }
  return (first as { id: string }).id;
}

async function claimInbox(manager: EntityManager, eventId: string): Promise<boolean> {
  const result = await manager
    .createQueryBuilder()
    .insert()
    .into(InboxMessageEntity)
    .values({ consumer: CONSUMER_NAME, eventId })
    .orIgnore()
    .returning(['id'])
    .execute();
  return result.identifiers.length === 1;
}
