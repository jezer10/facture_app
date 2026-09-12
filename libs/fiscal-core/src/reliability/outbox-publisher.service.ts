import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import type {
  SunatCommandEnvelope,
  PdfRenderEnvelope,
  WebhookEventEnvelope,
  WebhookEventType,
} from '@app/contracts';
import {
  coreDocumentArtifactObjectKey,
  SUNAT_COMMAND_JOB,
  CORE_ARTIFACTS_QUEUE,
  PDF_RENDER_JOB,
  SUNAT_COMMANDS_QUEUE,
  WEBHOOK_DELIVERY_JOB,
  WEBHOOKS_QUEUE,
} from '@app/contracts';
import { canonicalJson, OBJECT_STORAGE_PORT, sha256 } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';
import {
  FiscalDocumentEntity,
  DocumentArtifactEntity,
  DocumentStateHistoryEntity,
  OutboxEventEntity,
  ReceivedSyncEntity,
} from '../database/entities';
import { canonicalFiscalSnapshotArtifact } from './canonical-fiscal-snapshot';
import { nextOutboxRetry } from './outbox-retry-policy';
import type { OutboxRetryDecision } from './outbox-retry-policy';
import { enqueueWebhookEvent } from './webhook-outbox';

const CLAIM_LIMIT = 20;
const CLAIM_TTL_MS = 60_000;

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private publishing = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(SUNAT_COMMANDS_QUEUE)
    private readonly sunatCommands: Queue<SunatCommandEnvelope>,
    @InjectQueue(WEBHOOKS_QUEUE)
    private readonly webhooks: Queue<WebhookEventEnvelope>,
    @InjectQueue(CORE_ARTIFACTS_QUEUE)
    private readonly coreArtifacts: Queue<PdfRenderEnvelope>,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  @Interval(1000)
  async publishReadyEvents(): Promise<void> {
    if (this.publishing) {
      return;
    }
    this.publishing = true;
    try {
      const events = await this.claimReadyEvents();
      for (const event of events) {
        await this.publishOne(event);
      }
    } finally {
      this.publishing = false;
    }
  }

  private async claimReadyEvents(): Promise<OutboxEventEntity[]> {
    return this.dataSource.transaction(async (manager) => {
      const events = await manager
        .createQueryBuilder(OutboxEventEntity, 'event')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where(
          `(event.status IN ('pending', 'retrying', 'failed')
            OR (event.status = 'processing' AND event.lockedUntil < now()))`,
        )
        .andWhere('event.availableAt <= now()')
        .orderBy('event.createdAt', 'ASC')
        .take(CLAIM_LIMIT)
        .getMany();

      const lockedUntil = new Date(Date.now() + CLAIM_TTL_MS);
      for (const event of events) {
        event.status = 'processing';
        event.lockedUntil = lockedUntil;
        event.attempts += 1;
      }
      return manager.save(events);
    });
  }

  private async publishOne(event: OutboxEventEntity): Promise<void> {
    try {
      if (event.eventType.startsWith('sunat.')) {
        const command = await this.buildSunatCommand(event);
        await this.sunatCommands.add(SUNAT_COMMAND_JOB, command, {
          jobId: event.eventId,
          attempts: 4,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100_000 },
          removeOnFail: false,
        });
      } else if (event.eventType === 'core.pdf.requested.v1') {
        const renderEvent = this.buildPdfRenderEvent(event);
        await this.coreArtifacts.add(PDF_RENDER_JOB, renderEvent, {
          jobId: event.eventId,
          attempts: 4,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100_000 },
          removeOnFail: false,
        });
      } else if (event.eventType.startsWith('webhook.')) {
        const webhook = this.buildWebhookEvent(event);
        await this.webhooks.add(WEBHOOK_DELIVERY_JOB, webhook, {
          jobId: event.eventId,
          attempts: 8,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 30 * 24 * 60 * 60, count: 100_000 },
          removeOnFail: false,
        });
      } else {
        throw new Error(`Unsupported outbox event type: ${event.eventType}`);
      }

      await this.markSent(event);
    } catch {
      const retry = await this.reschedule(event);
      this.logger.error({
        attempts: event.attempts,
        eventId: event.eventId,
        eventType: event.eventType,
        code: 'OUTBOX_PUBLISH_FAILED',
        nextAttemptAt: retry.availableAt.toISOString(),
        retryStatus: retry.status,
      });
    }
  }

  private async buildSunatCommand(event: OutboxEventEntity): Promise<SunatCommandEnvelope> {
    if (event.eventType === 'sunat.document.issue.requested.v1') {
      const document = await this.dataSource.getRepository(FiscalDocumentEntity).findOneByOrFail({
        id: event.aggregateId,
        organizationId: event.organizationId,
      });
      const { body, sha256: digest } = canonicalFiscalSnapshotArtifact(
        document.fiscalSnapshot,
        document.snapshotSha256,
      );
      const key = coreDocumentArtifactObjectKey({
        organizationId: document.organizationId,
        issuerId: document.issuerId,
        documentId: document.id,
        kind: 'canonical-json',
        sha256: digest,
      });
      const stored = await this.storage.putImmutable({
        key,
        body,
        contentType: 'application/json',
        sha256: digest,
      });
      await this.rememberCanonicalArtifact(document.id, stored);
      return {
        ...baseEnvelope(event, key, digest),
        type: 'sunat.document.issue.requested.v1',
        payload: {
          documentId: document.id,
          documentType: document.documentType,
          series: document.series,
          number: document.number,
        },
      };
    }

    if (event.eventType === 'sunat.document.void.requested.v1') {
      const document = await this.dataSource.getRepository(FiscalDocumentEntity).findOneByOrFail({
        id: event.aggregateId,
        organizationId: event.organizationId,
      });
      const { body, sha256: digest } = canonicalFiscalSnapshotArtifact(
        document.fiscalSnapshot,
        document.snapshotSha256,
      );
      const key = coreDocumentArtifactObjectKey({
        organizationId: document.organizationId,
        issuerId: document.issuerId,
        documentId: document.id,
        kind: 'canonical-json',
        sha256: digest,
      });
      const stored = await this.storage.putImmutable({
        key,
        body,
        contentType: 'application/json',
        sha256: digest,
      });
      await this.rememberCanonicalArtifact(document.id, stored);
      return {
        ...baseEnvelope(event, key, digest),
        type: 'sunat.document.void.requested.v1',
        payload: {
          documentId: document.id,
          documentType: document.documentType,
          series: document.series,
          number: document.number,
          reason: payloadString(event.payload.reason, 'ANULACION'),
        },
      };
    }

    if (event.eventType === 'sunat.received.sync.requested.v1') {
      const sync = await this.dataSource.getRepository(ReceivedSyncEntity).findOneByOrFail({
        id: event.aggregateId,
        organizationId: event.organizationId,
      });
      const payload = {
        syncId: sync.id,
        startDate: sync.startDate,
        endDate: sync.endDate,
        documentTypes: (event.payload.documentTypes ?? ['01', '03', '07', '08']) as readonly (
          | '01'
          | '03'
          | '07'
          | '08'
        )[],
      };
      const body = Buffer.from(canonicalJson(payload), 'utf8');
      const digest = sha256(body);
      const key = `core/${sync.organizationId}/${sync.issuerId}/received-syncs/${sync.id}-${digest}.json`;
      await this.storage.putImmutable({
        key,
        body,
        contentType: 'application/json',
        sha256: digest,
      });
      return {
        ...baseEnvelope(event, key, digest),
        type: 'sunat.received.sync.requested.v1',
        payload,
      };
    }

    throw new Error(`Unsupported SUNAT command type: ${event.eventType}`);
  }

  private buildWebhookEvent(event: OutboxEventEntity): WebhookEventEnvelope {
    const eventType = event.eventType.slice('webhook.'.length) as WebhookEventType;
    const payload = {
      resourceId: event.aggregateId,
      resourceType: (event.payload.resourceType ?? 'fiscal-document') as
        | 'fiscal-document'
        | 'received-document',
      publicStatus: payloadString(event.payload.publicStatus, 'processing'),
      dataUrl: payloadString(event.payload.dataUrl, ''),
    };
    const payloadDigest = sha256(canonicalJson(payload));
    return {
      eventId: event.eventId,
      type: eventType,
      version: 1,
      occurredAt: event.createdAt.toISOString(),
      correlationId: event.correlationId,
      organizationId: event.organizationId,
      issuerId: event.issuerId,
      payloadRef: payload.dataUrl,
      payloadSha256: payloadDigest,
      payload,
    };
  }

  private buildPdfRenderEvent(event: OutboxEventEntity): PdfRenderEnvelope {
    const payload = { documentId: event.aggregateId };
    return {
      eventId: event.eventId,
      type: 'core.pdf.requested.v1',
      version: 1,
      occurredAt: event.createdAt.toISOString(),
      correlationId: event.correlationId,
      organizationId: event.organizationId,
      issuerId: event.issuerId,
      payloadRef: payloadString(event.payload.payloadRef, event.aggregateId),
      payloadSha256: payloadString(event.payload.payloadSha256, sha256(canonicalJson(payload))),
      payload,
    };
  }

  private async rememberCanonicalArtifact(
    documentId: string,
    stored: { key: string; contentType: string; sizeBytes: number; sha256: string },
  ): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(DocumentArtifactEntity)
      .values({
        documentId,
        kind: 'canonical-json',
        objectKey: stored.key,
        contentType: stored.contentType,
        sizeBytes: String(stored.sizeBytes),
        sha256: stored.sha256,
      })
      .orIgnore()
      .execute();
  }

  private async markSent(event: OutboxEventEntity): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.update(OutboxEventEntity, event.id, {
        status: 'sent',
        lockedUntil: null,
        lastErrorCode: null,
      });
      if (event.eventType === 'sunat.document.issue.requested.v1') {
        const document = await manager.findOne(FiscalDocumentEntity, {
          where: { id: event.aggregateId },
          lock: { mode: 'pessimistic_write' },
        });
        if (document?.status === 'queued') {
          document.status = 'processing';
          await manager.save(document);
          await manager.save(
            manager.create(DocumentStateHistoryEntity, {
              documentId: document.id,
              fromStatus: 'queued',
              toStatus: 'processing',
              reason: 'sunat-command-published',
              metadata: { sourceEventId: event.eventId },
            }),
          );
          await enqueueWebhookEvent(manager, {
            aggregateId: document.id,
            correlationId: event.correlationId,
            eventType: 'fiscal-document.processing.v1',
            issuerId: document.issuerId,
            organizationId: document.organizationId,
            publicStatus: 'processing',
            resourceType: 'fiscal-document',
          });
        }
      }
      if (event.eventType === 'sunat.received.sync.requested.v1') {
        await manager.update(
          ReceivedSyncEntity,
          { id: event.aggregateId, status: 'queued' },
          {
            status: 'processing',
          },
        );
      }
    });
  }

  private async reschedule(event: OutboxEventEntity): Promise<OutboxRetryDecision> {
    const retry = nextOutboxRetry(event.attempts, new Date());
    await this.dataSource.getRepository(OutboxEventEntity).update(event.id, {
      status: retry.status,
      lockedUntil: null,
      availableAt: retry.availableAt,
      lastErrorCode: 'OUTBOX_PUBLISH_FAILED',
    });
    return retry;
  }
}

interface BaseEnvelopeFields {
  readonly eventId: string;
  readonly version: 1;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly organizationId: string;
  readonly issuerId: string;
  readonly payloadRef: string;
  readonly payloadSha256: string;
}

function baseEnvelope(
  event: OutboxEventEntity,
  payloadRef: string,
  payloadSha256: string,
): BaseEnvelopeFields {
  return {
    eventId: event.eventId,
    version: 1 as const,
    occurredAt: event.createdAt.toISOString(),
    correlationId: event.correlationId,
    organizationId: event.organizationId,
    issuerId: event.issuerId,
    payloadRef,
    payloadSha256,
  };
}

function payloadString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
