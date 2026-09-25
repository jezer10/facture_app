import type { EncryptedEnvelope } from '@app/platform';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { WebhookDeliveryStatus } from '../../domain/webhook-delivery';
import type { WebhookSubscriptionStatus } from '../../domain/webhook-subscription';

@Entity({ name: 'webhook_subscriptions' })
@Index(['organizationId', 'id'], { unique: true })
export class WebhookSubscriptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'endpoint_url', type: 'text' })
  endpointUrl!: string;

  @Column({ name: 'event_types', type: 'text', array: true })
  eventTypes!: string[];

  @Index()
  @Column({ type: 'varchar', length: 20 })
  status!: WebhookSubscriptionStatus;

  @Column({ name: 'active_secret_version', type: 'integer' })
  activeSecretVersion!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'webhook_secret_versions' })
@Index(['subscriptionId', 'version'], { unique: true })
export class WebhookSecretVersionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Index()
  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId!: string;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ name: 'encrypted_envelope', type: 'jsonb' })
  encryptedEnvelope!: EncryptedEnvelope;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt!: Date | null;
}

@Entity({ name: 'webhook_deliveries' })
@Index(['organizationId', 'eventId', 'subscriptionId'], { unique: true })
@Index(['organizationId', 'id'], { unique: true })
export class WebhookDeliveryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Index()
  @Column({ name: 'event_id', type: 'varchar', length: 200 })
  eventId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 200 })
  eventType!: string;

  @Index()
  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId!: string;

  @Column({ name: 'raw_body', type: 'text' })
  rawBody!: string;

  @Column({ name: 'body_sha256', type: 'char', length: 64 })
  bodySha256!: string;

  @Index()
  @Column({ type: 'varchar', length: 30 })
  status!: WebhookDeliveryStatus;

  @Column({ name: 'attempt_count', type: 'integer' })
  attemptCount!: number;

  @Column({ name: 'first_attempt_at', type: 'timestamptz' })
  firstAttemptAt!: Date;

  @Column({ name: 'last_attempt_at', type: 'timestamptz' })
  lastAttemptAt!: Date;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @Column({ name: 'response_status', type: 'integer', nullable: true })
  responseStatus!: number | null;

  @Column({ name: 'failure_code', type: 'varchar', length: 80, nullable: true })
  failureCode!: string | null;

  @Column({ name: 'lock_token', type: 'uuid', nullable: true })
  lockToken!: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'webhook_delivery_attempts' })
export class WebhookDeliveryAttemptEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'attempt_number', type: 'integer' })
  attemptNumber!: number;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'varchar', length: 30 })
  status!: WebhookDeliveryStatus;

  @Column({ name: 'response_status', type: 'integer', nullable: true })
  responseStatus!: number | null;

  @Column({ name: 'failure_code', type: 'varchar', length: 80, nullable: true })
  failureCode!: string | null;
}

@Entity({ name: 'webhook_dead_letters' })
export class WebhookDeadLetterEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'event_id', type: 'varchar', length: 200 })
  eventId!: string;

  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId!: string;

  @Column({ name: 'failure_code', type: 'varchar', length: 80 })
  failureCode!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
