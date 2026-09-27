import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyRegistrations1790294520000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE company_registrations (
        id uuid PRIMARY KEY,
        subject varchar(160) NOT NULL,
        email varchar(254) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','approved','rejected')),
        data jsonb NOT NULL DEFAULT '{}',
        organization_id uuid REFERENCES organizations(id),
        issuer_id uuid REFERENCES issuers(id),
        decision_note varchar(2000),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX company_registrations_subject ON company_registrations(subject,created_at);
      CREATE TABLE company_registration_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        registration_id uuid NOT NULL REFERENCES company_registrations(id),
        actor varchar(160) NOT NULL,
        action varchar(30) NOT NULL,
        note varchar(2000),
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TABLE company_registration_events; DROP TABLE company_registrations',
    );
  }
}
