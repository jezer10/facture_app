import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AddBrowserAccessInvites1790294460000 implements MigrationInterface {
  name = 'AddBrowserAccessInvites1790294460000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE browser_access_invites (
      email varchar(254) NOT NULL,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role varchar(32) NOT NULL CHECK (role IN ('owner','admin','viewer')),
      claimed_subject varchar(160),
      expires_at timestamptz NOT NULL,
      PRIMARY KEY(email,organization_id)
    )`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE browser_access_invites');
  }
}
