import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCommandDeliveryOutbox1787356860000 implements MigrationInterface {
  name = 'AddCommandDeliveryOutbox1787356860000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE command_inbox
        ADD COLUMN processing_attempt integer NOT NULL DEFAULT 1
          CHECK (processing_attempt > 0),
        ADD COLUMN delivery_status varchar(16),
        ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0
          CHECK (delivery_attempts >= 0),
        ADD COLUMN delivery_available_at timestamptz,
        ADD COLUMN delivery_locked_until timestamptz,
        ADD COLUMN last_delivery_error_code varchar(100),
        ADD COLUMN delivered_at timestamptz;

      UPDATE command_inbox
      SET delivery_status = 'pending', delivery_available_at = now()
      WHERE status = 'completed';

      ALTER TABLE command_inbox
        ADD CONSTRAINT ck_command_inbox_delivery_status
          CHECK (delivery_status IS NULL OR delivery_status IN ('pending','publishing','delivered')),
        ADD CONSTRAINT ck_command_inbox_delivery_lifecycle
          CHECK (
            (status = 'processing'
              AND result IS NULL
              AND completed_at IS NULL
              AND delivery_status IS NULL)
            OR
            (status = 'completed'
              AND result IS NOT NULL
              AND completed_at IS NOT NULL
              AND delivery_status IS NOT NULL
              AND delivery_available_at IS NOT NULL)
          );

      CREATE INDEX idx_command_inbox_pending_delivery
        ON command_inbox(delivery_available_at, completed_at)
        WHERE status = 'completed' AND delivery_status IN ('pending','publishing');
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_command_inbox_pending_delivery;
      ALTER TABLE command_inbox
        DROP CONSTRAINT IF EXISTS ck_command_inbox_delivery_lifecycle,
        DROP CONSTRAINT IF EXISTS ck_command_inbox_delivery_status,
        DROP COLUMN IF EXISTS delivered_at,
        DROP COLUMN IF EXISTS last_delivery_error_code,
        DROP COLUMN IF EXISTS delivery_locked_until,
        DROP COLUMN IF EXISTS delivery_available_at,
        DROP COLUMN IF EXISTS delivery_attempts,
        DROP COLUMN IF EXISTS delivery_status,
        DROP COLUMN IF EXISTS processing_attempt;
    `);
  }
}
