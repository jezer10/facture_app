#!/usr/bin/env node
// Explicit, local-only bootstrap. It prepares access but never sends email or creates Cognito users.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const { values } = parseArgs({
  options: { email: { type: 'string' }, apply: { type: 'boolean', default: false } },
});
const email = values.email?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
  throw new Error('Use --email <administrator email> [--apply]');
const name = 'Plataforma · Desarrollo';
const slug = 'platform-identity-development';
if (!values.apply) {
  console.log(
    JSON.stringify(
      {
        database: '127.0.0.1:54330/billing_core',
        organization: name,
        email,
        role: 'owner',
        expiresInDays: 7,
        sendsEmail: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const client = new pg.Client({
  host: '127.0.0.1',
  port: 54330,
  database: 'billing_core',
  user: 'billing_core',
  password: readFileSync('deploy/secrets/local/core_db_password', 'utf8').trim(),
});
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(
    'INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3) ON CONFLICT(slug) DO NOTHING',
    [randomUUID(), name, slug],
  );
  const {
    rows: [organization],
  } = await client.query('SELECT id,name FROM organizations WHERE slug=$1', [slug]);
  if (organization.name !== name)
    throw new Error('Existing organization does not match the expected development organization');
  await client.query(
    "INSERT INTO browser_access_invites(email,organization_id,role,expires_at) VALUES($1,$2,'owner',now()+interval '7 days') ON CONFLICT(email,organization_id) DO NOTHING",
    [email, organization.id],
  );
  await client.query('COMMIT');
  console.log(
    JSON.stringify({
      organizationId: organization.id,
      organization: name,
      accessPrepared: true,
      sendsEmail: false,
    }),
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
