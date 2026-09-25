#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const secret = (name) => resolve(root, 'deploy/secrets/local', name);
const children = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

function run(command, args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    children.add(child);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      children.delete(child);
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`));
    });
  });
}

async function main() {
  const beta = process.argv.includes('--beta');
  const betaRuc = process.env.SUNAT_BETA_ISSUER_RUC;
  if (beta && !/^20\d{9}$/u.test(betaRuc ?? ''))
    throw new Error('Set SUNAT_BETA_ISSUER_RUC to the issuer RUC for beta.');
  await run('sh', ['scripts/generate-development-secrets.sh']);
  for (const [name, bytes] of [
    ['minio_access_key', 16],
    ['minio_secret_key', 32],
  ]) {
    try {
      writeFileSync(secret(name), randomBytes(bytes).toString('hex') + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (beta) {
    const cert = secret('beta_certificate.pem');
    if (
      !existsSync(cert) ||
      !existsSync(secret('beta_private.key')) ||
      Date.parse(new X509Certificate(readFileSync(cert)).validTo) < Date.now() + 86400000
    ) {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-sha256',
          '-nodes',
          '-days',
          '30',
          '-subj',
          '/CN=FACTURE BETA ONLY/O=TEST CERTIFICATE',
          '-keyout',
          secret('beta_private.key'),
          '-out',
          cert,
        ],
        { stdio: 'pipe' },
      );
      chmodSync(secret('beta_private.key'), 0o600);
    }
  }
  await run('docker', [
    'compose',
    '-f',
    'compose.local.yaml',
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '120',
  ]);

  // Build the local configuration explicitly so inherited cloud settings cannot leak in.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(BILLING_|CORE_DATABASE_|SUNAT_|WEBHOOK_|REDIS_|R2_|ALLOW_VOLATILE_ADAPTERS$)/u.test(key))
      delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'development',
    ALLOW_VOLATILE_ADAPTERS: 'false',
    BILLING_PUBLIC_URL: 'http://localhost:3300',
    BILLING_API_PORT: '3300',
    BILLING_WORKER_PORT: '3301',
    SUNAT_SERVICE_PORT: '3302',
    WEBHOOK_SERVICE_PORT: '3303',
    SUNAT_SERVICE_HOST: '127.0.0.1',
    SUNAT_INTERNAL_URL: 'http://127.0.0.1:3302',
    WEBHOOK_INTERNAL_URL: 'http://127.0.0.1:3303',
    CORE_DATABASE_URL: 'postgresql://billing_core@127.0.0.1:54330/billing_core',
    SUNAT_DATABASE_URL: 'postgresql://billing_sunat@127.0.0.1:54330/billing_sunat',
    WEBHOOK_DATABASE_URL: 'postgresql://billing_delivery@127.0.0.1:54330/billing_delivery',
    CORE_DATABASE_PASSWORD_FILE: secret('core_db_password'),
    SUNAT_DATABASE_PASSWORD_FILE: secret('sunat_db_password'),
    WEBHOOK_DATABASE_PASSWORD_FILE: secret('webhook_db_password'),
    BILLING_JWT_SECRET_FILE: secret('jwt_secret'),
    BILLING_API_KEY_PEPPER_FILE: secret('api_key_pepper'),
    BILLING_API_KEY_REPLAY_KEY_FILE: secret('api_key_replay_key'),
    SUNAT_INTERNAL_SERVICE_SECRET_FILE: secret('sunat_internal_secret'),
    WEBHOOK_INTERNAL_SERVICE_SECRET_FILE: secret('webhook_internal_secret'),
    SUNAT_PROVIDER_MODE: beta ? 'beta' : 'mock',
    BILLING_EMAIL_MODE: beta ? 'mailpit' : 'disabled',
    ...(beta
      ? {
          SUNAT_BETA_ISSUER_RUC: betaRuc,
          SUNAT_BETA_KEY_FILE: secret('beta_private.key'),
          SUNAT_BETA_CERT_FILE: secret('beta_certificate.pem'),
        }
      : {}),
    SUNAT_MOCK_ALLOW_ANY_ISSUER: 'true',
    R2_ENDPOINT: 'http://127.0.0.1:59000',
    R2_REGION: 'us-east-1',
    R2_BUCKET: 'billing-private',
    R2_ACCESS_KEY_ID_FILE: secret('minio_access_key'),
    R2_SECRET_ACCESS_KEY_FILE: secret('minio_secret_key'),
  });
  const storage = new S3Client({
    endpoint: env.R2_ENDPOINT,
    region: env.R2_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: readFileSync(env.R2_ACCESS_KEY_ID_FILE, 'utf8').trim(),
      secretAccessKey: readFileSync(env.R2_SECRET_ACCESS_KEY_FILE, 'utf8').trim(),
    },
  });
  try {
    try {
      await storage.send(new HeadBucketCommand({ Bucket: env.R2_BUCKET }));
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 404) throw error;
      await storage.send(new CreateBucketCommand({ Bucket: env.R2_BUCKET }));
    }
  } finally {
    storage.destroy();
  }
  await run('pnpm', ['migration:run:all'], { ...env, BILLING_SERVICE: 'migration-runner' });
  await run('pnpm', ['exec', 'playwright', 'install', '--only-shell', 'chromium'], env);
  await run('pnpm', ['build'], env);
  if (stopping) return;

  const services = [
    ['billing-api', {}],
    [
      'billing-worker',
      {
        REDIS_URL: 'redis://billing_worker@127.0.0.1:56379/0',
        REDIS_PASSWORD_FILE: secret('redis_worker_password'),
      },
    ],
    [
      'sunat-service',
      {
        REDIS_URL: 'redis://billing_sunat@127.0.0.1:56379/0',
        REDIS_PASSWORD_FILE: secret('redis_sunat_password'),
        BILLING_MASTER_KEY_FILE: secret('sunat_master_key'),
      },
    ],
    [
      'webhook-service',
      {
        REDIS_URL: 'redis://billing_webhook@127.0.0.1:56379/0',
        REDIS_PASSWORD_FILE: secret('redis_webhook_password'),
        BILLING_MASTER_KEY_FILE: secret('webhook_master_key'),
      },
    ],
  ];
  if (beta) console.log('SUNAT BETA - SIN VALIDEZ FISCAL. Correo local: http://localhost:58025');
  console.log(
    'Starting local services. API: http://localhost:3300/api/docs | MinIO: http://localhost:59001',
  );
  console.log(
    'Ctrl+C stops the applications. Use pnpm local:stop to stop Docker dependencies; data is preserved.',
  );
  await Promise.all(
    services.map(([name, overrides]) =>
      run(process.execPath, [`dist/apps/${name}/main.js`], {
        ...env,
        ...overrides,
        BILLING_SERVICE: name,
      }),
    ),
  );
}

main().catch((error) => {
  if (!stopping) console.error(error.message);
  stop(stopping ? process.exitCode : 1);
});
