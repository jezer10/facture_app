import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBillingDelivery1787356800000 implements MigrationInterface {
  name = 'CreateBillingDelivery1787356800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await queryRunner.query(`
      CREATE TABLE webhook_subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        endpoint_url text NOT NULL,
        event_types text[] NOT NULL,
        status varchar(20) NOT NULL CHECK (status IN ('active', 'disabled')),
        active_secret_version integer NOT NULL CHECK (active_secret_version > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, id),
        CHECK (cardinality(event_types) BETWEEN 1 AND 100)
      );
      CREATE INDEX idx_webhook_subscriptions_organization
        ON webhook_subscriptions(organization_id);
      CREATE INDEX idx_webhook_subscriptions_active_events
        ON webhook_subscriptions USING gin(event_types)
        WHERE status = 'active';

      CREATE TABLE webhook_secret_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        subscription_id uuid NOT NULL,
        version integer NOT NULL CHECK (version > 0),
        encrypted_envelope jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        retired_at timestamptz,
        UNIQUE (subscription_id, version),
        FOREIGN KEY (organization_id, subscription_id)
          REFERENCES webhook_subscriptions(organization_id, id)
          ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX uq_webhook_secret_versions_active
        ON webhook_secret_versions(subscription_id)
        WHERE retired_at IS NULL;
      CREATE INDEX idx_webhook_secret_versions_organization
        ON webhook_secret_versions(organization_id);

      CREATE TABLE webhook_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        event_id varchar(200) NOT NULL,
        event_type varchar(200) NOT NULL,
        subscription_id uuid NOT NULL,
        raw_body text NOT NULL,
        body_sha256 char(64) NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
        status varchar(30) NOT NULL CHECK (
          status IN ('processing', 'delivered', 'transient_failure', 'permanent_failure', 'dead_letter')
        ),
        attempt_count integer NOT NULL CHECK (attempt_count > 0),
        first_attempt_at timestamptz NOT NULL,
        last_attempt_at timestamptz NOT NULL,
        delivered_at timestamptz,
        response_status integer CHECK (response_status BETWEEN 100 AND 599),
        failure_code varchar(80),
        lock_token uuid,
        lease_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, event_id, subscription_id),
        UNIQUE (organization_id, id),
        FOREIGN KEY (organization_id, subscription_id)
          REFERENCES webhook_subscriptions(organization_id, id)
          ON DELETE RESTRICT,
        CHECK (
          (status = 'processing' AND lock_token IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR
          (status <> 'processing' AND lock_token IS NULL AND lease_expires_at IS NULL)
        )
      );
      CREATE INDEX idx_webhook_deliveries_event
        ON webhook_deliveries(organization_id, event_id);
      CREATE INDEX idx_webhook_deliveries_status
        ON webhook_deliveries(status, lease_expires_at);

      CREATE TABLE webhook_delivery_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        delivery_id uuid NOT NULL,
        organization_id uuid NOT NULL,
        attempt_number integer NOT NULL CHECK (attempt_number > 0),
        started_at timestamptz NOT NULL,
        completed_at timestamptz,
        status varchar(30) NOT NULL CHECK (
          status IN ('processing', 'delivered', 'transient_failure', 'permanent_failure', 'dead_letter')
        ),
        response_status integer CHECK (response_status BETWEEN 100 AND 599),
        failure_code varchar(80),
        FOREIGN KEY (organization_id, delivery_id)
          REFERENCES webhook_deliveries(organization_id, id)
          ON DELETE CASCADE
      );
      CREATE INDEX idx_webhook_delivery_attempts_delivery
        ON webhook_delivery_attempts(delivery_id, started_at);
      CREATE INDEX idx_webhook_delivery_attempts_organization
        ON webhook_delivery_attempts(organization_id, started_at);

      CREATE TABLE webhook_dead_letters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        delivery_id uuid NOT NULL UNIQUE,
        organization_id uuid NOT NULL,
        event_id varchar(200) NOT NULL,
        subscription_id uuid NOT NULL,
        failure_code varchar(80) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (organization_id, delivery_id)
          REFERENCES webhook_deliveries(organization_id, id)
          ON DELETE CASCADE
      );
      CREATE INDEX idx_webhook_dead_letters_organization
        ON webhook_dead_letters(organization_id, created_at DESC);
      CREATE INDEX idx_webhook_dead_letters_event
        ON webhook_dead_letters(organization_id, event_id);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS webhook_dead_letters;
      DROP TABLE IF EXISTS webhook_delivery_attempts;
      DROP TABLE IF EXISTS webhook_deliveries;
      DROP TABLE IF EXISTS webhook_secret_versions;
      DROP TABLE IF EXISTS webhook_subscriptions;
    `);
  }
}
