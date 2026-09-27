import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AddNativeLoginChallenges1790294580000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE browser_auth_challenges (
      token_hash char(64) PRIMARY KEY,
      username varchar(254) NOT NULL,
      challenge varchar(64) NOT NULL,
      provider_session text NOT NULL,
      expires_at timestamptz NOT NULL
    ); CREATE INDEX browser_auth_challenges_expiry ON browser_auth_challenges(expires_at);`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE browser_auth_challenges');
  }
}
