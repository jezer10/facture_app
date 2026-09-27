import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AddBrowserIdentityTokens1790380800000 implements MigrationInterface {
  name = 'AddBrowserIdentityTokens1790380800000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `CREATE TABLE browser_identity_tokens (token_hash char(64) PRIMARY KEY REFERENCES browser_sessions(token_hash) ON DELETE CASCADE, encrypted_access_token text NOT NULL)`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE browser_identity_tokens');
  }
}
