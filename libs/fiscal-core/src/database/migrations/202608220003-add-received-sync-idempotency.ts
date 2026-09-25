import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReceivedSyncIdempotency1787356920000 implements MigrationInterface {
  name = 'AddReceivedSyncIdempotency1787356920000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE received_syncs
        ADD COLUMN idempotency_key varchar(180),
        ADD COLUMN request_sha256 char(64);

      UPDATE received_syncs
      SET
        idempotency_key = 'legacy:' || id::text,
        request_sha256 = encode(sha256(convert_to('legacy:' || id::text, 'UTF8')), 'hex')
      WHERE idempotency_key IS NULL OR request_sha256 IS NULL;

      ALTER TABLE received_syncs
        ALTER COLUMN idempotency_key SET NOT NULL,
        ALTER COLUMN request_sha256 SET NOT NULL;

      ALTER TABLE received_syncs
        ADD CONSTRAINT uq_received_syncs_idempotency
        UNIQUE (organization_id, issuer_id, idempotency_key);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE received_syncs
        DROP CONSTRAINT IF EXISTS uq_received_syncs_idempotency,
        DROP COLUMN IF EXISTS request_sha256,
        DROP COLUMN IF EXISTS idempotency_key;
    `);
  }
}
