#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const keyFile = process.env.SANDBOX_API_KEY_FILE;
if (!keyFile)
  throw new Error(
    'Configura SANDBOX_API_KEY_FILE con una clave creada desde Configuración en Sandbox.',
  );
const apiKey = readFileSync(keyFile, 'utf8').trim();
const base = process.env.BILLING_API_URL ?? 'http://localhost:3300';
async function request(path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: `ApiKey ${apiKey}`,
      ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`La API rechazó ${path}: HTTP ${response.status}`);
  return response.json();
}
const workspace = await request('/workspace');
if (workspace.environment !== 'sandbox' || !workspace.canIssue)
  throw new Error('La clave debe pertenecer a un Sandbox habilitado.');
const [issuer] = await request('/fiscal-documents/creation-options');
const series = issuer?.series.find((item) => item.documentType === '01');
if (!series) throw new Error('Configura un emisor y una serie de factura en Sandbox.');
const document = await request('/fiscal-documents', {
  issuerId: issuer.id,
  seriesId: series.id,
  documentType: '01',
  currency: 'PEN',
  issueDate: new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()),
  customer: {
    identityType: '6',
    identityNumber: '20100070970',
    legalName: 'CLIENTE DE PRUEBA SANDBOX',
  },
  lines: [
    {
      description: 'Prueba de integración sin validez fiscal',
      unitCode: 'NIU',
      quantity: '2',
      unitValue: '10.00',
      taxAffectation: 'taxed',
      taxRate: '0.18',
    },
  ],
});
for (let attempt = 0; attempt < 30; attempt++) {
  const result = await request(`/fiscal-documents/${document.id}`);
  if (['accepted', 'accepted_with_observations'].includes(result.status)) {
    console.log(
      JSON.stringify({ environment: 'sandbox', documentId: result.id, status: result.status }),
    );
    process.exit(0);
  }
  if (['rejected', 'failed'].includes(result.status))
    throw new Error(`Documento ${result.id}: ${result.status}`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
throw new Error(`Envío ${document.id} sin confirmar. Consulta su estado; no repitas la emisión.`);
