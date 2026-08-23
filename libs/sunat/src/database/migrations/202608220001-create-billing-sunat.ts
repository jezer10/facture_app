import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBillingSunat1787356800000 implements MigrationInterface {
  name = 'CreateBillingSunat1787356800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await queryRunner.query(`
      CREATE TABLE issuer_credentials (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        issuer_id uuid NOT NULL,
        issuer_ruc char(11) NOT NULL CHECK (issuer_ruc ~ '^[0-9]{11}$'),
        environment varchar(16) NOT NULL CHECK (environment IN ('beta','production')),
        version integer NOT NULL CHECK (version > 0),
        sol_envelope jsonb NOT NULL,
        certificate_envelope jsonb,
        certificate_archive_sha256 char(64) CHECK (
          certificate_archive_sha256 IS NULL OR certificate_archive_sha256 ~ '^[0-9a-f]{64}$'
        ),
        certificate_expires_at timestamptz,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (issuer_id, version)
      );
      CREATE UNIQUE INDEX uq_issuer_credentials_active
        ON issuer_credentials(issuer_id) WHERE active = true;
      CREATE INDEX idx_issuer_credentials_organization
        ON issuer_credentials(organization_id);

      CREATE TABLE command_inbox (
        event_id varchar(120) PRIMARY KEY,
        status varchar(16) NOT NULL CHECK (status IN ('processing','completed')),
        result jsonb,
        locked_at timestamptz NOT NULL,
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((status = 'completed' AND result IS NOT NULL AND completed_at IS NOT NULL)
          OR status = 'processing')
      );
      CREATE INDEX idx_command_inbox_status_locked
        ON command_inbox(status, locked_at);

      CREATE TABLE submissions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        command_event_id varchar(120) NOT NULL UNIQUE,
        organization_id uuid NOT NULL,
        issuer_id uuid NOT NULL,
        document_id uuid NOT NULL,
        issuer_ruc char(11) NOT NULL CHECK (issuer_ruc ~ '^[0-9]{11}$'),
        document_type char(2) NOT NULL CHECK (document_type IN ('01','03','07','08')),
        series varchar(20) NOT NULL,
        number varchar(20) NOT NULL,
        operation varchar(24) NOT NULL CHECK (operation IN ('issue','void','daily_summary')),
        status varchar(24) NOT NULL CHECK (
          status IN ('processing','submitted','reconciling','accepted','rejected','voided','failed')
        ),
        payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
        provider_tracking_id varchar(160),
        ticket varchar(160),
        response_code varchar(80),
        response_description varchar(500),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (issuer_id, document_type, series, number, operation)
      );
      CREATE INDEX idx_submissions_organization ON submissions(organization_id);
      CREATE INDEX idx_submissions_issuer ON submissions(issuer_id);
      CREATE INDEX idx_submissions_status ON submissions(status);

      CREATE TABLE submission_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        attempt_number integer NOT NULL CHECK (attempt_number > 0),
        endpoint varchar(240) NOT NULL,
        outcome varchar(40) NOT NULL CHECK (
          outcome IN ('accepted','rejected','pending','ambiguous','failed')
        ),
        http_status integer,
        error_code varchar(100),
        provider_tracking_id varchar(160),
        ticket varchar(160),
        started_at timestamptz NOT NULL,
        completed_at timestamptz NOT NULL,
        UNIQUE (submission_id, attempt_number)
      );
      CREATE INDEX idx_submission_attempts_submission
        ON submission_attempts(submission_id);

      CREATE TABLE submission_tickets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        ticket varchar(160) NOT NULL UNIQUE,
        status varchar(24) NOT NULL CHECK (status IN ('pending','completed','failed')),
        last_checked_at timestamptz,
        next_check_at timestamptz,
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_submission_tickets_submission
        ON submission_tickets(submission_id);

      CREATE TABLE received_sync_cursors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        issuer_id uuid NOT NULL,
        document_type char(2) NOT NULL CHECK (document_type IN ('01','03','07','08')),
        source varchar(20) NOT NULL,
        last_issue_date date,
        provider_cursor varchar(500),
        last_synced_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (issuer_id, document_type, source)
      );
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS received_sync_cursors;
      DROP TABLE IF EXISTS submission_tickets;
      DROP TABLE IF EXISTS submission_attempts;
      DROP TABLE IF EXISTS submissions;
      DROP TABLE IF EXISTS command_inbox;
      DROP TABLE IF EXISTS issuer_credentials;
    `);
  }
}
