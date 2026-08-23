import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApiKeyCreationIdempotency1787357040000 implements MigrationInterface {
  name = 'AddApiKeyCreationIdempotency1787357040000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE api_keys
        ADD CONSTRAINT uq_api_keys_tenant_service_identity
        UNIQUE (id, organization_id, service_account_id);

      CREATE TABLE api_key_creation_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        service_account_id uuid NOT NULL,
        api_key_id uuid NOT NULL,
        idempotency_key varchar(180) NOT NULL,
        request_sha256 char(64) NOT NULL
          CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
        credential_envelope jsonb,
        replay_expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_api_key_creation_requests_tenant_key
          UNIQUE (organization_id, idempotency_key),
        CONSTRAINT fk_api_key_creation_requests_organization
          FOREIGN KEY (organization_id)
          REFERENCES organizations(id)
          ON DELETE CASCADE,
        CONSTRAINT fk_api_key_creation_requests_service_account_tenant
          FOREIGN KEY (service_account_id, organization_id)
          REFERENCES service_accounts(id, organization_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_api_key_creation_requests_api_key_tenant
          FOREIGN KEY (api_key_id, organization_id, service_account_id)
          REFERENCES api_keys(id, organization_id, service_account_id)
          ON DELETE RESTRICT
      );

      CREATE INDEX idx_api_key_creation_requests_api_key
        ON api_key_creation_requests(api_key_id);
      CREATE INDEX idx_api_key_creation_requests_expiring_replays
        ON api_key_creation_requests(replay_expires_at)
        WHERE credential_envelope IS NOT NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM api_key_creation_requests) THEN
          RAISE EXCEPTION USING
            ERRCODE = '2BP01',
            MESSAGE = 'cannot downgrade API-key idempotency while tombstones exist';
        END IF;
      END
      $$;

      DROP TABLE IF EXISTS api_key_creation_requests;
      ALTER TABLE api_keys
        DROP CONSTRAINT IF EXISTS uq_api_keys_tenant_service_identity;
    `);
  }
}
