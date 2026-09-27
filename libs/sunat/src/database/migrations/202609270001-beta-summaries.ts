import type { MigrationInterface, QueryRunner } from 'typeorm';
export class BetaSummaries1790467200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `CREATE TABLE beta_summary_sequences(issuer_id uuid NOT NULL, issue_date date NOT NULL, number integer NOT NULL CHECK(number BETWEEN 1 AND 99999), PRIMARY KEY(issuer_id,issue_date))`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE beta_summary_sequences');
  }
}
