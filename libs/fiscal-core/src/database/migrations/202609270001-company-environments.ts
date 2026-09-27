import type { MigrationInterface, QueryRunner } from 'typeorm';

/** An organization is an isolated workspace; a registration links its two environments. */
export class CompanyEnvironments1790467200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE organizations ADD COLUMN environment varchar(10) NOT NULL DEFAULT 'sandbox'
        CHECK (environment IN ('sandbox','production'));
      ALTER TABLE organizations ADD COLUMN company_id uuid;
      ALTER TABLE organizations ADD COLUMN verified_at timestamptz;
      ALTER TABLE organizations ADD CONSTRAINT organization_company_environment UNIQUE(company_id,environment);
      ALTER TABLE issuers DROP CONSTRAINT issuers_ruc_key;
      ALTER TABLE issuers ADD COLUMN environment varchar(10) NOT NULL DEFAULT 'sandbox'
        CHECK (environment IN ('sandbox','production'));
      CREATE UNIQUE INDEX issuer_ruc_per_workspace ON issuers(organization_id,ruc);
      CREATE UNIQUE INDEX issuer_production_ruc ON issuers(ruc) WHERE environment='production';
      CREATE FUNCTION enforce_issuer_environment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        SELECT environment INTO NEW.environment FROM organizations WHERE id=NEW.organization_id;
        RETURN NEW;
      END $$;
      CREATE TRIGGER issuer_environment BEFORE INSERT OR UPDATE ON issuers
        FOR EACH ROW EXECUTE FUNCTION enforce_issuer_environment();
      CREATE FUNCTION immutable_workspace_environment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.environment IS DISTINCT FROM OLD.environment THEN
          RAISE EXCEPTION 'Workspace environment is immutable; create a separate workspace';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER workspace_environment BEFORE UPDATE ON organizations
        FOR EACH ROW EXECUTE FUNCTION immutable_workspace_environment();
      ALTER TABLE company_registrations ADD COLUMN sandbox_organization_id uuid REFERENCES organizations(id);
      ALTER TABLE company_registrations ADD COLUMN sandbox_issuer_id uuid REFERENCES issuers(id);
      CREATE TABLE verified_email_recipients (
        organization_id uuid NOT NULL REFERENCES organizations(id),
        email varchar(254) NOT NULL,
        verified_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(organization_id,email)
      );
      -- Existing documents remain in sandbox. Approval never promotes historical operations.
      UPDATE organizations o SET company_id=r.id,verified_at=CASE WHEN r.status='approved' THEN now() END
        FROM company_registrations r WHERE r.organization_id=o.id;
      UPDATE company_registrations SET sandbox_organization_id=organization_id,sandbox_issuer_id=issuer_id,
        organization_id=NULL,issuer_id=NULL WHERE organization_id IS NOT NULL;
      INSERT INTO verified_email_recipients(organization_id,email)
        SELECT sandbox_organization_id,lower(trim(email)) FROM company_registrations
        WHERE sandbox_organization_id IS NOT NULL ON CONFLICT DO NOTHING;
    `);
    // Provision pending requests as well as separate, empty production workspaces for approved
    // registrations through the same transactional service used by subsequent submissions.
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = await runner.manager.query<{ count: string }[]>(
      "SELECT count(*) FROM organizations WHERE environment='production' OR company_id IS NOT NULL",
    );
    if (Number(rows[0]?.count))
      throw new Error('Cannot remove environment isolation from occupied workspaces.');
    await runner.query(`
      DROP TABLE verified_email_recipients;
      ALTER TABLE company_registrations DROP COLUMN sandbox_organization_id,DROP COLUMN sandbox_issuer_id;
      DROP TRIGGER workspace_environment ON organizations;
      DROP FUNCTION immutable_workspace_environment();
      DROP TRIGGER issuer_environment ON issuers;
      DROP FUNCTION enforce_issuer_environment();
      DROP INDEX issuer_production_ruc;
      DROP INDEX issuer_ruc_per_workspace;
      ALTER TABLE issuers DROP COLUMN environment,ADD CONSTRAINT issuers_ruc_key UNIQUE(ruc);
      ALTER TABLE organizations DROP COLUMN environment,DROP COLUMN company_id,DROP COLUMN verified_at;
    `);
  }
}
