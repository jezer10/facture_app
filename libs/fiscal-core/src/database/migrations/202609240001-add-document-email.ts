import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AddDocumentEmail1790208000000 implements MigrationInterface {
  name = 'AddDocumentEmail1790208000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE document_email_deliveries (
      document_id uuid PRIMARY KEY REFERENCES fiscal_documents(id) ON DELETE CASCADE,
      recipient varchar(254) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','unconfirmed')),
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz,
      error_code varchar(80),
      message_id varchar(180)
    )`);
    await runner.query(
      `CREATE INDEX document_email_pending ON document_email_deliveries(available_at) WHERE status = 'pending'`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE document_email_deliveries');
  }
}
