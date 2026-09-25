import { createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const secretPath = process.argv[2] ?? 'deploy/secrets/local/jwt_secret';
const subject = process.argv[3] ?? 'local-platform-admin';
const organizationId = process.argv[4];
const stat = statSync(secretPath);
if ((stat.mode & 0o077) !== 0) {
  throw new Error('JWT secret file must have mode 0600');
}
const secret = readFileSync(secretPath, 'utf8').trim();
const issuedAt = Math.floor(Date.now() / 1000);
const header = encode({ alg: 'HS256', typ: 'JWT' });
const payload = encode({
  sub: subject,
  ...(organizationId ? { organizationId } : { platformAdmin: true }),
  iss: process.env.BILLING_JWT_ISSUER ?? 'billing-admin',
  aud: process.env.BILLING_JWT_AUDIENCE ?? 'billing-api',
  iat: issuedAt,
  exp: issuedAt + 900,
});
const unsigned = `${header}.${payload}`;
const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
process.stdout.write(`${unsigned}.${signature}\n`);

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
