import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EnforceCoreTenantIsolation1787356980000 implements MigrationInterface {
  name = 'EnforceCoreTenantIsolation1787356980000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(TENANT_ISOLATION_PREFLIGHT);
    await queryRunner.query(ADD_TENANT_COLUMNS_AND_PARENT_KEYS);
    await queryRunner.query(REPLACE_INDEPENDENT_FOREIGN_KEYS);
    await queryRunner.query(INSTALL_TENANT_DERIVATION_TRIGGERS);
    await queryRunner.query(INSTALL_POLYMORPHIC_OUTBOX_GUARD);
    await queryRunner.query(VALIDATE_TENANT_CONSTRAINTS);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(REMOVE_TENANT_ISOLATION);
  }
}

const TENANT_ISOLATION_PREFLIGHT = `
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM api_keys child
      LEFT JOIN service_accounts parent ON parent.id = child.service_account_id
      WHERE parent.id IS NULL OR parent.organization_id <> child.organization_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'tenant isolation preflight failed: api_keys service account mismatch';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM service_account_issuer_grants grant_row
      LEFT JOIN service_accounts account_row ON account_row.id = grant_row.service_account_id
      LEFT JOIN issuers issuer_row ON issuer_row.id = grant_row.issuer_id
      WHERE account_row.id IS NULL
         OR issuer_row.id IS NULL
         OR account_row.organization_id <> grant_row.organization_id
         OR issuer_row.organization_id <> grant_row.organization_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'tenant isolation preflight failed: service account issuer grant mismatch';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM fiscal_documents document_row
      LEFT JOIN issuers issuer_row ON issuer_row.id = document_row.issuer_id
      LEFT JOIN issuer_series series_row ON series_row.id = document_row.series_id
      LEFT JOIN fiscal_documents reference_row
        ON reference_row.id = document_row.reference_document_id
      WHERE issuer_row.id IS NULL
         OR issuer_row.organization_id <> document_row.organization_id
         OR series_row.id IS NULL
         OR series_row.issuer_id <> document_row.issuer_id
         OR series_row.document_type <> document_row.document_type
         OR series_row.series <> document_row.series
         OR (
           document_row.reference_document_id IS NOT NULL
           AND (
             reference_row.id IS NULL
             OR reference_row.organization_id <> document_row.organization_id
           )
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'tenant isolation preflight failed: fiscal document relationship mismatch';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM received_syncs child
      LEFT JOIN issuers parent ON parent.id = child.issuer_id
      WHERE parent.id IS NULL OR parent.organization_id <> child.organization_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'tenant isolation preflight failed: received sync issuer mismatch';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM received_documents child
      LEFT JOIN issuers parent ON parent.id = child.recipient_issuer_id
      WHERE parent.id IS NULL OR parent.organization_id <> child.organization_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'tenant isolation preflight failed: received document issuer mismatch';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM idempotency_requests request_row
      WHERE request_row.resource_type <> 'fiscal_document'
         OR NOT EXISTS (
           SELECT 1
           FROM fiscal_documents document_row
           WHERE document_row.id = request_row.resource_id
             AND document_row.organization_id = request_row.organization_id
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'tenant isolation preflight failed: idempotency resource mismatch';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM outbox_events event_row
      WHERE NOT EXISTS (
        SELECT 1
        FROM issuers issuer_row
        WHERE issuer_row.id = event_row.issuer_id
          AND issuer_row.organization_id = event_row.organization_id
      )
      OR CASE event_row.aggregate_type
        WHEN 'fiscal_document' THEN NOT EXISTS (
          SELECT 1
          FROM fiscal_documents document_row
          WHERE document_row.id = event_row.aggregate_id
            AND document_row.organization_id = event_row.organization_id
            AND document_row.issuer_id = event_row.issuer_id
        )
        WHEN 'fiscal-document' THEN NOT EXISTS (
          SELECT 1
          FROM fiscal_documents document_row
          WHERE document_row.id = event_row.aggregate_id
            AND document_row.organization_id = event_row.organization_id
            AND document_row.issuer_id = event_row.issuer_id
        )
        WHEN 'received-sync' THEN NOT EXISTS (
          SELECT 1
          FROM received_syncs sync_row
          WHERE sync_row.id = event_row.aggregate_id
            AND sync_row.organization_id = event_row.organization_id
            AND sync_row.issuer_id = event_row.issuer_id
        )
        WHEN 'received-document' THEN NOT EXISTS (
          SELECT 1
          FROM received_documents document_row
          WHERE document_row.id = event_row.aggregate_id
            AND document_row.organization_id = event_row.organization_id
            AND document_row.recipient_issuer_id = event_row.issuer_id
        )
        ELSE true
      END
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'tenant isolation preflight failed: outbox aggregate mismatch';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM audit_log audit_row
      LEFT JOIN organizations organization_row ON organization_row.id = audit_row.organization_id
      WHERE organization_row.id IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'tenant isolation preflight failed: audit organization mismatch';
    END IF;
  END
  $$;
`;

const ADD_TENANT_COLUMNS_AND_PARENT_KEYS = `
  ALTER TABLE issuer_series ADD COLUMN organization_id uuid;
  ALTER TABLE fiscal_document_lines ADD COLUMN organization_id uuid;
  ALTER TABLE document_artifacts ADD COLUMN organization_id uuid;
  ALTER TABLE document_state_history ADD COLUMN organization_id uuid;
  ALTER TABLE received_document_artifacts ADD COLUMN organization_id uuid;

  UPDATE issuer_series child
  SET organization_id = parent.organization_id
  FROM issuers parent
  WHERE parent.id = child.issuer_id;

  UPDATE fiscal_document_lines child
  SET organization_id = parent.organization_id
  FROM fiscal_documents parent
  WHERE parent.id = child.document_id;

  UPDATE document_artifacts child
  SET organization_id = parent.organization_id
  FROM fiscal_documents parent
  WHERE parent.id = child.document_id;

  UPDATE document_state_history child
  SET organization_id = parent.organization_id
  FROM fiscal_documents parent
  WHERE parent.id = child.document_id;

  UPDATE received_document_artifacts child
  SET organization_id = parent.organization_id
  FROM received_documents parent
  WHERE parent.id = child.received_document_id;

  ALTER TABLE issuer_series ALTER COLUMN organization_id SET NOT NULL;
  ALTER TABLE fiscal_document_lines ALTER COLUMN organization_id SET NOT NULL;
  ALTER TABLE document_artifacts ALTER COLUMN organization_id SET NOT NULL;
  ALTER TABLE document_state_history ALTER COLUMN organization_id SET NOT NULL;
  ALTER TABLE received_document_artifacts ALTER COLUMN organization_id SET NOT NULL;

  ALTER TABLE service_accounts
    ADD CONSTRAINT uq_service_accounts_id_organization UNIQUE (id, organization_id);
  ALTER TABLE issuers
    ADD CONSTRAINT uq_issuers_id_organization UNIQUE (id, organization_id);
  ALTER TABLE issuer_series
    ADD CONSTRAINT uq_issuer_series_tenant_identity
    UNIQUE (id, organization_id, issuer_id, document_type, series);
  ALTER TABLE fiscal_documents
    ADD CONSTRAINT uq_fiscal_documents_id_organization UNIQUE (id, organization_id);
  ALTER TABLE received_documents
    ADD CONSTRAINT uq_received_documents_id_organization UNIQUE (id, organization_id);

  CREATE INDEX idx_api_keys_service_account_tenant
    ON api_keys(service_account_id, organization_id);
  CREATE INDEX idx_grants_issuer_tenant
    ON service_account_issuer_grants(issuer_id, organization_id);
  CREATE INDEX idx_fiscal_documents_series_tenant
    ON fiscal_documents(series_id, organization_id, issuer_id, document_type, series);
  CREATE INDEX idx_fiscal_documents_reference_tenant
    ON fiscal_documents(reference_document_id, organization_id)
    WHERE reference_document_id IS NOT NULL;
  CREATE INDEX idx_idempotency_requests_resource_tenant
    ON idempotency_requests(resource_id, organization_id);
  CREATE INDEX idx_outbox_events_issuer_tenant
    ON outbox_events(issuer_id, organization_id);
  CREATE INDEX idx_received_syncs_issuer_tenant
    ON received_syncs(issuer_id, organization_id);
  CREATE INDEX idx_received_documents_issuer_tenant
    ON received_documents(recipient_issuer_id, organization_id);
`;

const REPLACE_INDEPENDENT_FOREIGN_KEYS = `
  ALTER TABLE api_keys
    DROP CONSTRAINT IF EXISTS api_keys_service_account_id_fkey,
    ADD CONSTRAINT fk_api_keys_service_account_tenant
      FOREIGN KEY (service_account_id, organization_id)
      REFERENCES service_accounts(id, organization_id)
      ON DELETE CASCADE NOT VALID;

  ALTER TABLE service_account_issuer_grants
    DROP CONSTRAINT IF EXISTS service_account_issuer_grants_service_account_id_fkey,
    DROP CONSTRAINT IF EXISTS service_account_issuer_grants_issuer_id_fkey,
    ADD CONSTRAINT fk_grants_service_account_tenant
      FOREIGN KEY (service_account_id, organization_id)
      REFERENCES service_accounts(id, organization_id)
      ON DELETE CASCADE NOT VALID,
    ADD CONSTRAINT fk_grants_issuer_tenant
      FOREIGN KEY (issuer_id, organization_id)
      REFERENCES issuers(id, organization_id)
      ON DELETE CASCADE NOT VALID;

  ALTER TABLE issuer_series
    DROP CONSTRAINT IF EXISTS issuer_series_issuer_id_fkey,
    ADD CONSTRAINT fk_issuer_series_issuer_tenant
      FOREIGN KEY (issuer_id, organization_id)
      REFERENCES issuers(id, organization_id)
      ON DELETE RESTRICT NOT VALID;

  ALTER TABLE fiscal_documents
    DROP CONSTRAINT IF EXISTS fiscal_documents_issuer_id_fkey,
    DROP CONSTRAINT IF EXISTS fiscal_documents_series_id_fkey,
    DROP CONSTRAINT IF EXISTS fiscal_documents_reference_document_id_fkey,
    ADD CONSTRAINT fk_fiscal_documents_issuer_tenant
      FOREIGN KEY (issuer_id, organization_id)
      REFERENCES issuers(id, organization_id)
      ON DELETE RESTRICT NOT VALID,
    ADD CONSTRAINT fk_fiscal_documents_series_tenant
      FOREIGN KEY (series_id, organization_id, issuer_id, document_type, series)
      REFERENCES issuer_series(id, organization_id, issuer_id, document_type, series)
      ON DELETE RESTRICT NOT VALID,
    ADD CONSTRAINT fk_fiscal_documents_reference_tenant
      FOREIGN KEY (reference_document_id, organization_id)
      REFERENCES fiscal_documents(id, organization_id)
      ON DELETE RESTRICT NOT VALID;

  ALTER TABLE fiscal_document_lines
    DROP CONSTRAINT IF EXISTS fiscal_document_lines_document_id_fkey,
    ADD CONSTRAINT fk_fiscal_document_lines_document_tenant
      FOREIGN KEY (document_id, organization_id)
      REFERENCES fiscal_documents(id, organization_id)
      ON DELETE CASCADE NOT VALID;

  ALTER TABLE document_artifacts
    DROP CONSTRAINT IF EXISTS document_artifacts_document_id_fkey,
    ADD CONSTRAINT fk_document_artifacts_document_tenant
      FOREIGN KEY (document_id, organization_id)
      REFERENCES fiscal_documents(id, organization_id)
      ON DELETE CASCADE NOT VALID;

  ALTER TABLE document_state_history
    DROP CONSTRAINT IF EXISTS document_state_history_document_id_fkey,
    ADD CONSTRAINT fk_document_state_history_document_tenant
      FOREIGN KEY (document_id, organization_id)
      REFERENCES fiscal_documents(id, organization_id)
      ON DELETE CASCADE NOT VALID;

  ALTER TABLE idempotency_requests
    ADD CONSTRAINT ck_idempotency_requests_resource_type
      CHECK (resource_type = 'fiscal_document') NOT VALID,
    ADD CONSTRAINT fk_idempotency_requests_document_tenant
      FOREIGN KEY (resource_id, organization_id)
      REFERENCES fiscal_documents(id, organization_id)
      ON DELETE CASCADE NOT VALID;

  ALTER TABLE outbox_events
    ADD CONSTRAINT ck_outbox_events_aggregate_type
      CHECK (
        aggregate_type IN (
          'fiscal_document',
          'fiscal-document',
          'received-sync',
          'received-document'
        )
      ) NOT VALID,
    ADD CONSTRAINT fk_outbox_events_issuer_tenant
      FOREIGN KEY (issuer_id, organization_id)
      REFERENCES issuers(id, organization_id)
      ON DELETE RESTRICT NOT VALID;

  ALTER TABLE received_syncs
    DROP CONSTRAINT IF EXISTS received_syncs_issuer_id_fkey,
    ADD CONSTRAINT fk_received_syncs_issuer_tenant
      FOREIGN KEY (issuer_id, organization_id)
      REFERENCES issuers(id, organization_id)
      ON DELETE RESTRICT NOT VALID;

  ALTER TABLE received_documents
    DROP CONSTRAINT IF EXISTS received_documents_recipient_issuer_id_fkey,
    ADD CONSTRAINT fk_received_documents_issuer_tenant
      FOREIGN KEY (recipient_issuer_id, organization_id)
      REFERENCES issuers(id, organization_id)
      ON DELETE RESTRICT NOT VALID;

  ALTER TABLE received_document_artifacts
    DROP CONSTRAINT IF EXISTS received_document_artifacts_received_document_id_fkey,
    ADD CONSTRAINT fk_received_artifacts_document_tenant
      FOREIGN KEY (received_document_id, organization_id)
      REFERENCES received_documents(id, organization_id)
      ON DELETE CASCADE NOT VALID;

  ALTER TABLE audit_log
    ADD CONSTRAINT fk_audit_log_organization
      FOREIGN KEY (organization_id)
      REFERENCES organizations(id)
      ON DELETE RESTRICT NOT VALID;
`;

const INSTALL_TENANT_DERIVATION_TRIGGERS = `
  CREATE FUNCTION core_set_issuer_series_organization()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    expected_organization_id uuid;
  BEGIN
    SELECT organization_id INTO expected_organization_id
    FROM issuers
    WHERE id = NEW.issuer_id;

    IF expected_organization_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'tenant isolation violation: issuer series references an unknown issuer';
    END IF;
    IF NEW.organization_id IS NOT NULL
       AND NEW.organization_id <> expected_organization_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'tenant isolation violation: issuer series organization mismatch';
    END IF;
    NEW.organization_id := expected_organization_id;
    RETURN NEW;
  END
  $$;

  CREATE TRIGGER trg_issuer_series_set_organization
  BEFORE INSERT OR UPDATE OF issuer_id, organization_id ON issuer_series
  FOR EACH ROW EXECUTE FUNCTION core_set_issuer_series_organization();

  CREATE FUNCTION core_set_document_child_organization()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    expected_organization_id uuid;
  BEGIN
    SELECT organization_id INTO expected_organization_id
    FROM fiscal_documents
    WHERE id = NEW.document_id;

    IF expected_organization_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'tenant isolation violation: document child references an unknown document';
    END IF;
    IF NEW.organization_id IS NOT NULL
       AND NEW.organization_id <> expected_organization_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'tenant isolation violation: document child organization mismatch';
    END IF;
    NEW.organization_id := expected_organization_id;
    RETURN NEW;
  END
  $$;

  CREATE TRIGGER trg_fiscal_document_lines_set_organization
  BEFORE INSERT OR UPDATE OF document_id, organization_id ON fiscal_document_lines
  FOR EACH ROW EXECUTE FUNCTION core_set_document_child_organization();
  CREATE TRIGGER trg_document_artifacts_set_organization
  BEFORE INSERT OR UPDATE OF document_id, organization_id ON document_artifacts
  FOR EACH ROW EXECUTE FUNCTION core_set_document_child_organization();
  CREATE TRIGGER trg_document_state_history_set_organization
  BEFORE INSERT OR UPDATE OF document_id, organization_id ON document_state_history
  FOR EACH ROW EXECUTE FUNCTION core_set_document_child_organization();

  CREATE FUNCTION core_set_received_artifact_organization()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    expected_organization_id uuid;
  BEGIN
    SELECT organization_id INTO expected_organization_id
    FROM received_documents
    WHERE id = NEW.received_document_id;

    IF expected_organization_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'tenant isolation violation: received artifact references an unknown document';
    END IF;
    IF NEW.organization_id IS NOT NULL
       AND NEW.organization_id <> expected_organization_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'tenant isolation violation: received artifact organization mismatch';
    END IF;
    NEW.organization_id := expected_organization_id;
    RETURN NEW;
  END
  $$;

  CREATE TRIGGER trg_received_artifacts_set_organization
  BEFORE INSERT OR UPDATE OF received_document_id, organization_id
  ON received_document_artifacts
  FOR EACH ROW EXECUTE FUNCTION core_set_received_artifact_organization();
`;

const INSTALL_POLYMORPHIC_OUTBOX_GUARD = `
  CREATE FUNCTION core_enforce_outbox_aggregate_tenant()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    aggregate_matches boolean;
  BEGIN
    CASE NEW.aggregate_type
      WHEN 'fiscal_document' THEN
        SELECT EXISTS (
          SELECT 1 FROM fiscal_documents
          WHERE id = NEW.aggregate_id
            AND organization_id = NEW.organization_id
            AND issuer_id = NEW.issuer_id
        ) INTO aggregate_matches;
      WHEN 'fiscal-document' THEN
        SELECT EXISTS (
          SELECT 1 FROM fiscal_documents
          WHERE id = NEW.aggregate_id
            AND organization_id = NEW.organization_id
            AND issuer_id = NEW.issuer_id
        ) INTO aggregate_matches;
      WHEN 'received-sync' THEN
        SELECT EXISTS (
          SELECT 1 FROM received_syncs
          WHERE id = NEW.aggregate_id
            AND organization_id = NEW.organization_id
            AND issuer_id = NEW.issuer_id
        ) INTO aggregate_matches;
      WHEN 'received-document' THEN
        SELECT EXISTS (
          SELECT 1 FROM received_documents
          WHERE id = NEW.aggregate_id
            AND organization_id = NEW.organization_id
            AND recipient_issuer_id = NEW.issuer_id
        ) INTO aggregate_matches;
      ELSE
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'tenant isolation violation: unsupported outbox aggregate type';
    END CASE;

    IF NOT aggregate_matches THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'tenant isolation violation: outbox aggregate mismatch';
    END IF;
    RETURN NEW;
  END
  $$;

  CREATE TRIGGER trg_outbox_events_enforce_aggregate_tenant
  BEFORE INSERT OR UPDATE OF aggregate_type, aggregate_id, organization_id, issuer_id
  ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION core_enforce_outbox_aggregate_tenant();
`;

const VALIDATE_TENANT_CONSTRAINTS = `
  ALTER TABLE api_keys VALIDATE CONSTRAINT fk_api_keys_service_account_tenant;
  ALTER TABLE service_account_issuer_grants
    VALIDATE CONSTRAINT fk_grants_service_account_tenant;
  ALTER TABLE service_account_issuer_grants
    VALIDATE CONSTRAINT fk_grants_issuer_tenant;
  ALTER TABLE issuer_series VALIDATE CONSTRAINT fk_issuer_series_issuer_tenant;
  ALTER TABLE fiscal_documents VALIDATE CONSTRAINT fk_fiscal_documents_issuer_tenant;
  ALTER TABLE fiscal_documents VALIDATE CONSTRAINT fk_fiscal_documents_series_tenant;
  ALTER TABLE fiscal_documents VALIDATE CONSTRAINT fk_fiscal_documents_reference_tenant;
  ALTER TABLE fiscal_document_lines
    VALIDATE CONSTRAINT fk_fiscal_document_lines_document_tenant;
  ALTER TABLE document_artifacts VALIDATE CONSTRAINT fk_document_artifacts_document_tenant;
  ALTER TABLE document_state_history
    VALIDATE CONSTRAINT fk_document_state_history_document_tenant;
  ALTER TABLE idempotency_requests VALIDATE CONSTRAINT ck_idempotency_requests_resource_type;
  ALTER TABLE idempotency_requests
    VALIDATE CONSTRAINT fk_idempotency_requests_document_tenant;
  ALTER TABLE outbox_events VALIDATE CONSTRAINT ck_outbox_events_aggregate_type;
  ALTER TABLE outbox_events VALIDATE CONSTRAINT fk_outbox_events_issuer_tenant;
  ALTER TABLE received_syncs VALIDATE CONSTRAINT fk_received_syncs_issuer_tenant;
  ALTER TABLE received_documents VALIDATE CONSTRAINT fk_received_documents_issuer_tenant;
  ALTER TABLE received_document_artifacts
    VALIDATE CONSTRAINT fk_received_artifacts_document_tenant;
  ALTER TABLE audit_log VALIDATE CONSTRAINT fk_audit_log_organization;
`;

const REMOVE_TENANT_ISOLATION = `
  DROP TRIGGER IF EXISTS trg_outbox_events_enforce_aggregate_tenant ON outbox_events;
  DROP FUNCTION IF EXISTS core_enforce_outbox_aggregate_tenant();
  DROP TRIGGER IF EXISTS trg_received_artifacts_set_organization
    ON received_document_artifacts;
  DROP FUNCTION IF EXISTS core_set_received_artifact_organization();
  DROP TRIGGER IF EXISTS trg_document_state_history_set_organization
    ON document_state_history;
  DROP TRIGGER IF EXISTS trg_document_artifacts_set_organization ON document_artifacts;
  DROP TRIGGER IF EXISTS trg_fiscal_document_lines_set_organization
    ON fiscal_document_lines;
  DROP FUNCTION IF EXISTS core_set_document_child_organization();
  DROP TRIGGER IF EXISTS trg_issuer_series_set_organization ON issuer_series;
  DROP FUNCTION IF EXISTS core_set_issuer_series_organization();

  ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS fk_audit_log_organization;
  ALTER TABLE received_document_artifacts
    DROP CONSTRAINT IF EXISTS fk_received_artifacts_document_tenant;
  ALTER TABLE received_documents
    DROP CONSTRAINT IF EXISTS fk_received_documents_issuer_tenant;
  ALTER TABLE received_syncs DROP CONSTRAINT IF EXISTS fk_received_syncs_issuer_tenant;
  ALTER TABLE outbox_events
    DROP CONSTRAINT IF EXISTS fk_outbox_events_issuer_tenant,
    DROP CONSTRAINT IF EXISTS ck_outbox_events_aggregate_type;
  ALTER TABLE idempotency_requests
    DROP CONSTRAINT IF EXISTS fk_idempotency_requests_document_tenant,
    DROP CONSTRAINT IF EXISTS ck_idempotency_requests_resource_type;
  ALTER TABLE document_state_history
    DROP CONSTRAINT IF EXISTS fk_document_state_history_document_tenant;
  ALTER TABLE document_artifacts
    DROP CONSTRAINT IF EXISTS fk_document_artifacts_document_tenant;
  ALTER TABLE fiscal_document_lines
    DROP CONSTRAINT IF EXISTS fk_fiscal_document_lines_document_tenant;
  ALTER TABLE fiscal_documents
    DROP CONSTRAINT IF EXISTS fk_fiscal_documents_reference_tenant,
    DROP CONSTRAINT IF EXISTS fk_fiscal_documents_series_tenant,
    DROP CONSTRAINT IF EXISTS fk_fiscal_documents_issuer_tenant;
  ALTER TABLE issuer_series DROP CONSTRAINT IF EXISTS fk_issuer_series_issuer_tenant;
  ALTER TABLE service_account_issuer_grants
    DROP CONSTRAINT IF EXISTS fk_grants_issuer_tenant,
    DROP CONSTRAINT IF EXISTS fk_grants_service_account_tenant;
  ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS fk_api_keys_service_account_tenant;

  ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_service_account_id_fkey
    FOREIGN KEY (service_account_id) REFERENCES service_accounts(id) ON DELETE CASCADE;
  ALTER TABLE service_account_issuer_grants
    ADD CONSTRAINT service_account_issuer_grants_service_account_id_fkey
      FOREIGN KEY (service_account_id) REFERENCES service_accounts(id) ON DELETE CASCADE,
    ADD CONSTRAINT service_account_issuer_grants_issuer_id_fkey
      FOREIGN KEY (issuer_id) REFERENCES issuers(id) ON DELETE CASCADE;
  ALTER TABLE issuer_series
    ADD CONSTRAINT issuer_series_issuer_id_fkey
    FOREIGN KEY (issuer_id) REFERENCES issuers(id) ON DELETE RESTRICT;
  ALTER TABLE fiscal_documents
    ADD CONSTRAINT fiscal_documents_issuer_id_fkey
      FOREIGN KEY (issuer_id) REFERENCES issuers(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fiscal_documents_series_id_fkey
      FOREIGN KEY (series_id) REFERENCES issuer_series(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fiscal_documents_reference_document_id_fkey
      FOREIGN KEY (reference_document_id) REFERENCES fiscal_documents(id) ON DELETE RESTRICT;
  ALTER TABLE fiscal_document_lines
    ADD CONSTRAINT fiscal_document_lines_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES fiscal_documents(id) ON DELETE CASCADE;
  ALTER TABLE document_artifacts
    ADD CONSTRAINT document_artifacts_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES fiscal_documents(id) ON DELETE CASCADE;
  ALTER TABLE document_state_history
    ADD CONSTRAINT document_state_history_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES fiscal_documents(id) ON DELETE CASCADE;
  ALTER TABLE received_syncs
    ADD CONSTRAINT received_syncs_issuer_id_fkey
    FOREIGN KEY (issuer_id) REFERENCES issuers(id) ON DELETE RESTRICT;
  ALTER TABLE received_documents
    ADD CONSTRAINT received_documents_recipient_issuer_id_fkey
    FOREIGN KEY (recipient_issuer_id) REFERENCES issuers(id) ON DELETE RESTRICT;
  ALTER TABLE received_document_artifacts
    ADD CONSTRAINT received_document_artifacts_received_document_id_fkey
    FOREIGN KEY (received_document_id) REFERENCES received_documents(id) ON DELETE CASCADE;

  DROP INDEX IF EXISTS idx_received_documents_issuer_tenant;
  DROP INDEX IF EXISTS idx_received_syncs_issuer_tenant;
  DROP INDEX IF EXISTS idx_outbox_events_issuer_tenant;
  DROP INDEX IF EXISTS idx_idempotency_requests_resource_tenant;
  DROP INDEX IF EXISTS idx_fiscal_documents_reference_tenant;
  DROP INDEX IF EXISTS idx_fiscal_documents_series_tenant;
  DROP INDEX IF EXISTS idx_grants_issuer_tenant;
  DROP INDEX IF EXISTS idx_api_keys_service_account_tenant;

  ALTER TABLE received_documents
    DROP CONSTRAINT IF EXISTS uq_received_documents_id_organization;
  ALTER TABLE fiscal_documents
    DROP CONSTRAINT IF EXISTS uq_fiscal_documents_id_organization;
  ALTER TABLE issuer_series DROP CONSTRAINT IF EXISTS uq_issuer_series_tenant_identity;
  ALTER TABLE issuers DROP CONSTRAINT IF EXISTS uq_issuers_id_organization;
  ALTER TABLE service_accounts
    DROP CONSTRAINT IF EXISTS uq_service_accounts_id_organization;

  ALTER TABLE received_document_artifacts DROP COLUMN IF EXISTS organization_id;
  ALTER TABLE document_state_history DROP COLUMN IF EXISTS organization_id;
  ALTER TABLE document_artifacts DROP COLUMN IF EXISTS organization_id;
  ALTER TABLE fiscal_document_lines DROP COLUMN IF EXISTS organization_id;
  ALTER TABLE issuer_series DROP COLUMN IF EXISTS organization_id;
`;
