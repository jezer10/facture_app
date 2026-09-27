import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AddBrowserAuth1790294400000 implements MigrationInterface {
  name = 'AddBrowserAuth1790294400000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE browser_login_attempts (
      state_hash char(64) PRIMARY KEY,
      binding_hash char(64) NOT NULL,
      verifier varchar(128) NOT NULL,
      nonce varchar(128) NOT NULL,
      expires_at timestamptz NOT NULL
    )`);
    await runner.query(`CREATE INDEX browser_login_expiry ON browser_login_attempts(expires_at)`);
    await runner.query(`CREATE TABLE browser_sessions (
      token_hash char(64) PRIMARY KEY,
      subject varchar(160) NOT NULL,
      email varchar(254) NOT NULL,
      csrf_token varchar(128) NOT NULL,
      organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE INDEX browser_session_expiry ON browser_sessions(expires_at)`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE browser_sessions');
    await runner.query('DROP TABLE browser_login_attempts');
  }
}
