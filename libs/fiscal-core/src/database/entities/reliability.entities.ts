import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'idempotency_requests' })
@Index(['organizationId', 'key'], { unique: true })
export class IdempotencyRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ type: 'varchar', length: 180 })
  key!: string;

  @Column({ name: 'request_sha256', type: 'char', length: 64 })
  requestSha256!: string;

  @Column({ name: 'resource_type', type: 'varchar', length: 60 })
  resourceType!: string;

  @Column({ name: 'resource_id', type: 'uuid' })
  resourceId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'outbox_events' })
export class OutboxEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'aggregate_type', type: 'varchar', length: 80 })
  aggregateType!: string;

  @Index()
  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 120 })
  eventType!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'issuer_id', type: 'uuid' })
  issuerId!: string;

  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Index()
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: 'pending' | 'processing' | 'retrying' | 'sent' | 'failed';

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'available_at', type: 'timestamptz' })
  availableAt!: Date;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'last_error_code', type: 'varchar', length: 80, nullable: true })
  lastErrorCode!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'inbox_messages' })
@Index(['consumer', 'eventId'], { unique: true })
export class InboxMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 80 })
  consumer!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt!: Date;
}

@Entity({ name: 'received_syncs' })
@Index(['organizationId', 'issuerId', 'idempotencyKey'], { unique: true })
export class ReceivedSyncEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'issuer_id', type: 'uuid' })
  issuerId!: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 180 })
  idempotencyKey!: string;

  @Column({ name: 'request_sha256', type: 'char', length: 64 })
  requestSha256!: string;

  @Column({ type: 'varchar', length: 30 })
  status!: 'queued' | 'processing' | 'completed' | 'failed';

  @Column({ name: 'result_summary', type: 'jsonb', default: {} })
  resultSummary!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'received_documents' })
@Index(
  [
    'organizationId',
    'recipientIssuerId',
    'supplierRuc',
    'documentType',
    'series',
    'number',
    'source',
  ],
  { unique: true },
)
export class ReceivedDocumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'recipient_issuer_id', type: 'uuid' })
  recipientIssuerId!: string;

  @Column({ name: 'supplier_ruc', type: 'char', length: 11 })
  supplierRuc!: string;

  @Column({ name: 'document_type', type: 'char', length: 2 })
  documentType!: string;

  @Column({ type: 'varchar', length: 4 })
  series!: string;

  @Column({ type: 'varchar', length: 20 })
  number!: string;

  @Column({ type: 'varchar', length: 20 })
  source!: string;

  @Column({ name: 'issue_date', type: 'date' })
  issueDate!: string;

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;

  @Column({ name: 'snapshot_sha256', type: 'char', length: 64 })
  snapshotSha256!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'received_document_artifacts' })
@Index(['receivedDocumentId', 'kind', 'sha256'], { unique: true })
export class ReceivedDocumentArtifactEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid', insert: false, update: false })
  organizationId!: string;

  @Column({ name: 'received_document_id', type: 'uuid' })
  receivedDocumentId!: string;

  @Column({ type: 'varchar', length: 32 })
  kind!: string;

  @Column({ name: 'object_key', type: 'text' })
  objectKey!: string;

  @Column({ type: 'char', length: 64 })
  sha256!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 120 })
  contentType!: string;

  @Column({ name: 'size_bytes', type: 'bigint' })
  sizeBytes!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'audit_log' })
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'actor_type', type: 'varchar', length: 30 })
  actorType!: 'human' | 'service' | 'system';

  @Column({ name: 'actor_id', type: 'varchar', length: 160 })
  actorId!: string;

  @Column({ type: 'varchar', length: 120 })
  action!: string;

  @Column({ name: 'resource_type', type: 'varchar', length: 80 })
  resourceType!: string;

  @Column({ name: 'resource_id', type: 'varchar', length: 160 })
  resourceId!: string;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
