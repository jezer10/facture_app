import type { CompletedSunatCommand } from '../../application/sunat-command-executor';
import type { FiscalDocumentType } from '../../domain/models/fiscal-document';
import {
  Column,
  Check,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'command_inbox' })
export class SunatCommandInboxEntity {
  @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 120 })
  eventId!: string;

  @Index()
  @Column({ type: 'varchar', length: 16 })
  status!: 'processing' | 'completed';

  @Column({ type: 'jsonb', nullable: true })
  result!: CompletedSunatCommand | null;

  @Column({ name: 'locked_at', type: 'timestamptz' })
  lockedAt!: Date;

  @Column({ name: 'processing_attempt', type: 'integer', default: 1 })
  processingAttempt!: number;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Index()
  @Column({ name: 'delivery_status', type: 'varchar', length: 16, nullable: true })
  deliveryStatus!: 'pending' | 'publishing' | 'delivered' | null;

  @Column({ name: 'delivery_attempts', type: 'integer', default: 0 })
  deliveryAttempts!: number;

  @Column({ name: 'delivery_available_at', type: 'timestamptz', nullable: true })
  deliveryAvailableAt!: Date | null;

  @Column({ name: 'delivery_locked_until', type: 'timestamptz', nullable: true })
  deliveryLockedUntil!: Date | null;

  @Column({ name: 'last_delivery_error_code', type: 'varchar', length: 100, nullable: true })
  lastDeliveryErrorCode!: string | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export type SunatSubmissionOperation = 'issue' | 'void' | 'daily_summary';
export type SunatSubmissionStatus =
  | 'processing'
  | 'submitted'
  | 'reconciling'
  | 'accepted'
  | 'rejected'
  | 'voided'
  | 'failed';

@Entity({ name: 'submissions' })
@Index(['issuerId', 'documentType', 'series', 'number', 'operation'], {
  unique: true,
})
@Check('ck_submissions_payload_sha256', `payload_sha256 ~ '^[0-9a-f]{64}$'`)
export class SunatSubmissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'command_event_id', type: 'varchar', length: 120 })
  commandEventId!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Index()
  @Column({ name: 'issuer_id', type: 'uuid' })
  issuerId!: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId!: string;

  @Column({ name: 'issuer_ruc', type: 'char', length: 11 })
  issuerRuc!: string;

  @Column({ name: 'document_type', type: 'char', length: 2 })
  documentType!: FiscalDocumentType;

  @Column({ type: 'varchar', length: 20 })
  series!: string;

  @Column({ type: 'varchar', length: 20 })
  number!: string;

  @Column({ type: 'varchar', length: 24 })
  operation!: SunatSubmissionOperation;

  @Index()
  @Column({ type: 'varchar', length: 24 })
  status!: SunatSubmissionStatus;

  @Column({ name: 'payload_sha256', type: 'char', length: 64 })
  payloadSha256!: string;

  @Column({ name: 'provider_tracking_id', type: 'varchar', length: 160, nullable: true })
  providerTrackingId!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  ticket!: string | null;

  @Column({ name: 'response_code', type: 'varchar', length: 80, nullable: true })
  responseCode!: string | null;

  @Column({ name: 'response_description', type: 'varchar', length: 500, nullable: true })
  responseDescription!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'submission_attempts' })
@Index(['submissionId', 'attemptNumber'], { unique: true })
export class SunatSubmissionAttemptEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'submission_id', type: 'uuid' })
  submissionId!: string;

  @Column({ name: 'attempt_number', type: 'integer' })
  attemptNumber!: number;

  @Column({ type: 'varchar', length: 240 })
  endpoint!: string;

  @Column({ type: 'varchar', length: 40 })
  outcome!: 'accepted' | 'rejected' | 'pending' | 'ambiguous' | 'failed';

  @Column({ name: 'http_status', type: 'integer', nullable: true })
  httpStatus!: number | null;

  @Column({ name: 'error_code', type: 'varchar', length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: 'provider_tracking_id', type: 'varchar', length: 160, nullable: true })
  providerTrackingId!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  ticket!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz' })
  completedAt!: Date;
}

@Entity({ name: 'submission_tickets' })
export class SunatSubmissionTicketEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'submission_id', type: 'uuid' })
  submissionId!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 160 })
  ticket!: string;

  @Column({ type: 'varchar', length: 24 })
  status!: 'pending' | 'completed' | 'failed';

  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  @Column({ name: 'next_check_at', type: 'timestamptz', nullable: true })
  nextCheckAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'received_sync_cursors' })
@Index(['issuerId', 'documentType', 'source'], { unique: true })
export class SunatReceivedSyncCursorEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'issuer_id', type: 'uuid' })
  issuerId!: string;

  @Column({ name: 'document_type', type: 'char', length: 2 })
  documentType!: FiscalDocumentType;

  @Column({ type: 'varchar', length: 20 })
  source!: string;

  @Column({ name: 'last_issue_date', type: 'date', nullable: true })
  lastIssueDate!: string | null;

  @Column({ name: 'provider_cursor', type: 'varchar', length: 500, nullable: true })
  providerCursor!: string | null;

  @Column({ name: 'last_synced_at', type: 'timestamptz' })
  lastSyncedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
