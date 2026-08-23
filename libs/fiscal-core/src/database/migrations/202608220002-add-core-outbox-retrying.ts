import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCoreOutboxRetrying1787356860000 implements MigrationInterface {
  name = 'AddCoreOutboxRetrying1787356860000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE outbox_events
        DROP CONSTRAINT IF EXISTS outbox_events_status_check;

      ALTER TABLE outbox_events
        ADD CONSTRAINT outbox_events_status_check
        CHECK (status IN ('pending','processing','retrying','sent','failed'));

      UPDATE outbox_events
      SET status = 'retrying',
          available_at = now(),
          locked_until = NULL,
          last_error_code = COALESCE(last_error_code, 'OUTBOX_PUBLISH_FAILED'),
          updated_at = now()
      WHERE status = 'failed';
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE outbox_events
      SET status = 'failed', locked_until = NULL, updated_at = now()
      WHERE status = 'retrying';

      ALTER TABLE outbox_events
        DROP CONSTRAINT IF EXISTS outbox_events_status_check;

      ALTER TABLE outbox_events
        ADD CONSTRAINT outbox_events_status_check
        CHECK (status IN ('pending','processing','sent','failed'));
    `);
  }
}
