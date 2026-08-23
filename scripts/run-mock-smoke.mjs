#!/usr/bin/env node

import { createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const apiUrl = withoutTrailingSlash(process.env.BILLING_API_URL ?? 'http://localhost:3300');
const jwtSecretPath = process.env.BILLING_JWT_SECRET_FILE ?? 'deploy/secrets/local/jwt_secret';
const subject = `local-smoke-${Date.now()}`;
const suffix = String(Date.now()).slice(-8);
const issuerRuc = peruvianRuc(`20${suffix}`);
const customerRuc = peruvianRuc(
  `20${String(Number(suffix) + 1)
    .padStart(8, '0')
    .slice(-8)}`,
);
const issueDate = limaDate(new Date());

const platformToken = createDevelopmentJwt(readSecret(jwtSecretPath), subject);
const organization = await request('/api/v1/organizations', {
  method: 'POST',
  token: platformToken,
  body: {
    name: `Smoke ${suffix}`,
    slug: `smoke-${Date.now()}`,
    ownerSubject: subject,
  },
});
const organizationId = requiredString(organization, 'id');
const organizationToken = createDevelopmentJwt(readSecret(jwtSecretPath), subject, organizationId);

const issuer = await request('/api/v1/issuers', {
  method: 'POST',
  token: organizationToken,
  body: { ruc: issuerRuc, legalName: `Smoke Emisor ${suffix} SAC` },
});
const issuerId = requiredString(issuer, 'id');

const series = await request(`/api/v1/issuers/${issuerId}/series`, {
  method: 'POST',
  token: organizationToken,
  body: { documentType: '01', series: 'F001', nextNumber: 1 },
});
const seriesId = requiredString(series, 'id');

const serviceAccount = await request('/api/v1/service-accounts', {
  method: 'POST',
  token: organizationToken,
  body: { name: 'Smoke generator' },
});
const serviceAccountId = requiredString(serviceAccount, 'id');

await request(`/api/v1/service-accounts/${serviceAccountId}/issuer-grants`, {
  method: 'POST',
  token: organizationToken,
  body: { issuerId },
});

const createdKey = await request(`/api/v1/service-accounts/${serviceAccountId}/api-keys`, {
  method: 'POST',
  token: organizationToken,
  headers: { 'idempotency-key': `smoke-key-${Date.now()}` },
  body: { scopes: ['documents:write', 'documents:read'] },
});
const apiKey = requiredString(createdKey, 'apiKey');

const accepted = await request('/api/v1/fiscal-documents', {
  method: 'POST',
  apiKey,
  headers: { 'idempotency-key': `smoke-${Date.now()}` },
  body: {
    issuerId,
    seriesId,
    documentType: '01',
    issueDate,
    currency: 'PEN',
    customer: {
      identityType: '6',
      identityNumber: customerRuc,
      legalName: `Smoke Cliente ${suffix} SAC`,
    },
    lines: [
      {
        description: 'Servicio de prueba no fiscal',
        unitCode: 'NIU',
        quantity: '1',
        unitValue: '100.00',
        taxAffectation: 'taxed',
        taxRate: '0.18',
      },
    ],
  },
});
const documentId = requiredString(accepted, 'id');
const terminalDocument = await pollDocument(documentId, apiKey);
const finalStatus = requiredString(terminalDocument, 'status');
if (!['accepted', 'accepted_with_observations'].includes(finalStatus)) {
  throw new Error(`Mock document ended in unexpected status: ${finalStatus}`);
}

await pollArtifact(documentId, 'canonical-json', apiKey);
await pollArtifact(documentId, 'xml', apiKey);
await pollArtifact(documentId, 'pdf', apiKey);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      mode: 'mock-no-fiscal-validity',
      organizationId,
      issuerId,
      serviceAccountId,
      documentId,
      status: finalStatus,
      artifactsVerified: ['canonical-json', 'xml', 'pdf'],
    },
    null,
    2,
  )}\n`,
);

async function pollDocument(documentId, apiKey) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const document = await request(`/api/v1/fiscal-documents/${documentId}`, {
      method: 'GET',
      apiKey,
    });
    const status = requiredString(document, 'status');
    if (
      ['accepted', 'accepted_with_observations', 'rejected', 'failed', 'voided'].includes(status)
    ) {
      return document;
    }
    await delay(1_000);
  }
  throw new Error('Timed out waiting for the mock document result');
}

async function pollArtifact(documentId, kind, apiKey) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${apiUrl}/api/v1/fiscal-documents/${encodeURIComponent(documentId)}/artifacts/${kind}`,
      { headers: { authorization: `ApiKey ${apiKey}` } },
    );
    if (response.ok) {
      const value = await response.json();
      const signedUrl = requiredString(value, 'url');
      await downloadAndValidateArtifact(kind, signedUrl);
      return;
    }
    if (response.status !== 404) {
      throw await responseError(response);
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${kind} artifact`);
}

async function downloadAndValidateArtifact(kind, signedUrl) {
  let response;
  try {
    response = await fetch(signedUrl);
  } catch {
    throw new Error(`Could not download ${kind} artifact`);
  }
  if (!response.ok) {
    throw new Error(`Download for ${kind} artifact returned HTTP ${response.status}`);
  }

  let body;
  try {
    body = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new Error(`Could not read ${kind} artifact response`);
  }
  if (body.byteLength === 0) {
    throw new Error(`${kind} artifact response is empty`);
  }
  validateArtifact(kind, body);
}

function validateArtifact(kind, body) {
  if (kind === 'canonical-json') {
    validateJsonArtifact(body);
    return;
  }
  if (kind === 'xml') {
    if (!body.toString('utf8').trimStart().startsWith('<')) {
      throw new Error('xml artifact does not start with an XML element');
    }
    return;
  }
  if (kind === 'pdf') {
    if (!body.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('pdf artifact does not have a PDF signature');
    }
    return;
  }
  throw new Error('Smoke test requested an unsupported artifact kind');
}

function validateJsonArtifact(body) {
  try {
    JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('canonical-json artifact is not valid JSON');
  }
}

async function request(path, options) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method,
    headers: {
      authorization: options.apiKey ? `ApiKey ${options.apiKey}` : `Bearer ${options.token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return response.json();
}

async function responseError(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The sanitized HTTP error below remains the only observable failure.
  }
  return new Error(`Billing API returned HTTP ${response.status}`);
}

function createDevelopmentJwt(secret, subject, organizationId) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const header = encodeJwtPart({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJwtPart({
    sub: subject,
    ...(organizationId ? { organizationId } : { platformAdmin: true }),
    iss: process.env.BILLING_JWT_ISSUER ?? 'billing-admin',
    aud: process.env.BILLING_JWT_AUDIENCE ?? 'billing-api',
    iat: issuedAt,
    exp: issuedAt + 900,
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function readSecret(path) {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`JWT secret must be a regular 0600 file: ${path}`);
  }
  return readFileSync(path, 'utf8').trim();
}

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function requiredString(value, field) {
  if (typeof value !== 'object' || value === null || typeof value[field] !== 'string') {
    throw new Error(`Response is missing string field: ${field}`);
  }
  return value[field];
}

function peruvianRuc(firstTenDigits) {
  if (!/^20\d{8}$/u.test(firstTenDigits)) {
    throw new Error('RUC seed must have ten digits and start with 20');
  }
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce(
    (total, weight, index) => total + Number(firstTenDigits[index]) * weight,
    0,
  );
  const remainder = 11 - (sum % 11);
  const digit = remainder === 10 ? 0 : remainder === 11 ? 1 : remainder;
  return `${firstTenDigits}${digit}`;
}

function limaDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(value)
    .reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function withoutTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
