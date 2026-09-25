import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBillingCore1787356800000 implements MigrationInterface {
  name = 'CreateBillingCore1787356800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await queryRunner.query(`
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(160) NOT NULL,
        slug varchar(80) NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE organization_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        subject varchar(160) NOT NULL,
        role varchar(32) NOT NULL CHECK (role IN ('owner','admin','viewer')),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, subject)
      );
      CREATE TABLE service_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name varchar(160) NOT NULL,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_service_accounts_organization ON service_accounts(organization_id);
      CREATE TABLE api_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        service_account_id uuid NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
        prefix varchar(24) NOT NULL UNIQUE,
        digest char(64) NOT NULL,
        scopes text[] NOT NULL,
        expires_at timestamptz,
        revoked_at timestamptz,
        last_used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_api_keys_organization ON api_keys(organization_id);
      CREATE INDEX idx_api_keys_service_account ON api_keys(service_account_id);
      CREATE TABLE issuers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        ruc char(11) NOT NULL UNIQUE CHECK (ruc ~ '^[0-9]{11}$'),
        legal_name varchar(200) NOT NULL,
        trade_name varchar(200),
        address jsonb NOT NULL DEFAULT '{}'::jsonb,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_issuers_organization ON issuers(organization_id);
      CREATE TABLE service_account_issuer_grants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        service_account_id uuid NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
        issuer_id uuid NOT NULL REFERENCES issuers(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (service_account_id, issuer_id)
      );
      CREATE TABLE issuer_series (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        issuer_id uuid NOT NULL REFERENCES issuers(id) ON DELETE RESTRICT,
        document_type char(2) NOT NULL CHECK (document_type IN ('01','03','07','08')),
        series varchar(4) NOT NULL,
        next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (issuer_id, document_type, series)
      );
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        identity_type varchar(2) NOT NULL,
        identity_number varchar(20) NOT NULL,
        legal_name varchar(200) NOT NULL,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, identity_type, identity_number)
      );
      CREATE TABLE catalog_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        code varchar(80) NOT NULL,
        description varchar(500) NOT NULL,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, code)
      );
      CREATE TABLE fiscal_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        issuer_id uuid NOT NULL REFERENCES issuers(id) ON DELETE RESTRICT,
        series_id uuid NOT NULL REFERENCES issuer_series(id) ON DELETE RESTRICT,
        document_type char(2) NOT NULL CHECK (document_type IN ('01','03','07','08')),
        series varchar(4) NOT NULL,
        number bigint NOT NULL CHECK (number > 0),
        issue_date date NOT NULL,
        currency char(3) NOT NULL,
        status varchar(40) NOT NULL CHECK (status IN ('queued','processing','accepted','accepted_with_observations','rejected','failed','void_pending','voided')),
        customer_snapshot jsonb NOT NULL,
        fiscal_snapshot jsonb NOT NULL,
        snapshot_sha256 char(64) NOT NULL,
        totals jsonb NOT NULL,
        reference_document_id uuid REFERENCES fiscal_documents(id) ON DELETE RESTRICT,
        accepted_at timestamptz,
        voided_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (issuer_id, document_type, series, number)
      );
      CREATE INDEX idx_fiscal_documents_organization ON fiscal_documents(organization_id);
      CREATE INDEX idx_fiscal_documents_issuer ON fiscal_documents(issuer_id);
      CREATE INDEX idx_fiscal_documents_status ON fiscal_documents(status);
      CREATE TABLE fiscal_document_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES fiscal_documents(id) ON DELETE CASCADE,
        line_number integer NOT NULL CHECK (line_number > 0),
        snapshot jsonb NOT NULL,
        UNIQUE (document_id, line_number)
      );
      CREATE TABLE document_artifacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES fiscal_documents(id) ON DELETE CASCADE,
        kind varchar(32) NOT NULL,
        object_key text NOT NULL,
        sha256 char(64) NOT NULL,
        content_type varchar(120) NOT NULL,
        size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (document_id, kind, sha256)
      );
      CREATE TABLE document_state_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES fiscal_documents(id) ON DELETE CASCADE,
        from_status varchar(40),
        to_status varchar(40) NOT NULL,
        reason varchar(120) NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_document_state_history_document ON document_state_history(document_id);
      CREATE TABLE idempotency_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        key varchar(180) NOT NULL,
        request_sha256 char(64) NOT NULL,
        resource_type varchar(60) NOT NULL,
        resource_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, key)
      );
      CREATE TABLE outbox_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL UNIQUE,
        aggregate_type varchar(80) NOT NULL,
        aggregate_id uuid NOT NULL,
        event_type varchar(120) NOT NULL,
        organization_id uuid NOT NULL,
        issuer_id uuid NOT NULL,
        correlation_id uuid NOT NULL,
        payload jsonb NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
        attempts integer NOT NULL DEFAULT 0,
        available_at timestamptz NOT NULL DEFAULT now(),
        locked_until timestamptz,
        last_error_code varchar(80),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_outbox_events_ready ON outbox_events(status, available_at, locked_until);
      CREATE INDEX idx_outbox_events_aggregate ON outbox_events(aggregate_id);
      CREATE TABLE inbox_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        consumer varchar(80) NOT NULL,
        event_id uuid NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (consumer, event_id)
      );
      CREATE TABLE received_syncs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        issuer_id uuid NOT NULL REFERENCES issuers(id) ON DELETE RESTRICT,
        start_date date NOT NULL,
        end_date date NOT NULL,
        status varchar(30) NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
        result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_received_syncs_organization ON received_syncs(organization_id);
      CREATE TABLE received_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        recipient_issuer_id uuid NOT NULL REFERENCES issuers(id) ON DELETE RESTRICT,
        supplier_ruc char(11) NOT NULL,
        document_type char(2) NOT NULL,
        series varchar(4) NOT NULL,
        number varchar(20) NOT NULL,
        source varchar(20) NOT NULL,
        issue_date date NOT NULL,
        snapshot jsonb NOT NULL,
        snapshot_sha256 char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, recipient_issuer_id, supplier_ruc, document_type, series, number, source)
      );
      CREATE TABLE received_document_artifacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        received_document_id uuid NOT NULL REFERENCES received_documents(id) ON DELETE CASCADE,
        kind varchar(32) NOT NULL,
        object_key text NOT NULL,
        sha256 char(64) NOT NULL,
        content_type varchar(120) NOT NULL,
        size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (received_document_id, kind, sha256)
      );
      CREATE TABLE audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        actor_type varchar(30) NOT NULL CHECK (actor_type IN ('human','service','system')),
        actor_id varchar(160) NOT NULL,
        action varchar(120) NOT NULL,
        resource_type varchar(80) NOT NULL,
        resource_id varchar(160) NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_audit_log_organization ON audit_log(organization_id, created_at DESC);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS audit_log;
      DROP TABLE IF EXISTS received_document_artifacts;
      DROP TABLE IF EXISTS received_documents;
      DROP TABLE IF EXISTS received_syncs;
      DROP TABLE IF EXISTS inbox_messages;
      DROP TABLE IF EXISTS outbox_events;
      DROP TABLE IF EXISTS idempotency_requests;
      DROP TABLE IF EXISTS document_state_history;
      DROP TABLE IF EXISTS document_artifacts;
      DROP TABLE IF EXISTS fiscal_document_lines;
      DROP TABLE IF EXISTS fiscal_documents;
      DROP TABLE IF EXISTS catalog_items;
      DROP TABLE IF EXISTS customers;
      DROP TABLE IF EXISTS issuer_series;
      DROP TABLE IF EXISTS service_account_issuer_grants;
      DROP TABLE IF EXISTS issuers;
      DROP TABLE IF EXISTS api_keys;
      DROP TABLE IF EXISTS service_accounts;
      DROP TABLE IF EXISTS organization_members;
      DROP TABLE IF EXISTS organizations;
    `);
  }
}
