import type { ArtifactReference, FiscalDocumentType, PublicDocumentStatus } from '@app/contracts';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'fiscal_documents' })
@Index(['issuerId', 'documentType', 'series', 'number'], { unique: true })
export class FiscalDocumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Index()
  @Column({ name: 'issuer_id', type: 'uuid' })
  issuerId!: string;

  @Column({ name: 'series_id', type: 'uuid' })
  seriesId!: string;

  @Column({ name: 'document_type', type: 'char', length: 2 })
  documentType!: FiscalDocumentType;

  @Column({ type: 'varchar', length: 4 })
  series!: string;

  @Column({ type: 'bigint' })
  number!: string;

  @Column({ name: 'issue_date', type: 'date' })
  issueDate!: string;

  @Column({ type: 'char', length: 3 })
  currency!: 'PEN' | 'USD';

  @Index()
  @Column({ type: 'varchar', length: 40 })
  status!: PublicDocumentStatus;

  @Column({ name: 'customer_snapshot', type: 'jsonb' })
  customerSnapshot!: Record<string, unknown>;

  @Column({ name: 'fiscal_snapshot', type: 'jsonb' })
  fiscalSnapshot!: Record<string, unknown>;

  @Column({ name: 'snapshot_sha256', type: 'char', length: 64 })
  snapshotSha256!: string;

  @Column({ type: 'jsonb' })
  totals!: Record<string, string>;

  @Column({ name: 'reference_document_id', type: 'uuid', nullable: true })
  referenceDocumentId!: string | null;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ name: 'voided_at', type: 'timestamptz', nullable: true })
  voidedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'fiscal_document_lines' })
@Index(['documentId', 'lineNumber'], { unique: true })
export class FiscalDocumentLineEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid', insert: false, update: false })
  organizationId!: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId!: string;

  @Column({ name: 'line_number', type: 'integer' })
  lineNumber!: number;

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;
}

@Entity({ name: 'document_artifacts' })
@Index(['documentId', 'kind', 'sha256'], { unique: true })
export class DocumentArtifactEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid', insert: false, update: false })
  organizationId!: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId!: string;

  @Column({ type: 'varchar', length: 32 })
  kind!: ArtifactReference['kind'];

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

@Entity({ name: 'document_state_history' })
export class DocumentStateHistoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid', insert: false, update: false })
  organizationId!: string;

  @Index()
  @Column({ name: 'document_id', type: 'uuid' })
  documentId!: string;

  @Column({ name: 'from_status', type: 'varchar', length: 40, nullable: true })
  fromStatus!: PublicDocumentStatus | null;

  @Column({ name: 'to_status', type: 'varchar', length: 40 })
  toStatus!: PublicDocumentStatus;

  @Column({ type: 'varchar', length: 120 })
  reason!: string;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
