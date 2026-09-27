import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
let organizationId = 'sandbox';
let provisioned = null;
const organizations = [
  {
    id: 'sandbox',
    name: 'Estudio Norte SAC',
    role: 'owner',
    environment: 'sandbox',
    companyId: 'company',
  },
  {
    id: 'production',
    name: 'Estudio Norte SAC',
    role: 'owner',
    environment: 'production',
    companyId: 'company',
  },
];
const keys = [];
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await context.route('**/api/v1/**', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const body = req.postData() ? req.postDataJSON() : null;
  const respond = (data) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  if (path.endsWith('/auth/organization')) organizationId = body.organizationId;
  if (path.includes('/auth/'))
    return respond({
      enabled: true,
      authenticated: true,
      email: 'owner@example.test',
      csrfToken: 'csrf',
      organizationId,
      organizations,
    });
  if (req.method() !== 'GET') assert.equal(req.headers()['x-csrf-token'], 'csrf');
  if (path.endsWith('/workspace'))
    return respond({
      id: organizationId,
      environment: organizationId,
      sunat: organizationId === 'sandbox' ? 'beta' : 'production',
      canIssue: organizationId === 'sandbox',
      fiscalValidity: false,
      email: 'disabled',
      message:
        organizationId === 'sandbox'
          ? 'Sandbox · Sin validez fiscal'
          : 'Producción pendiente de conexión SUNAT',
      verifiedRecipients: ['owner@example.test'],
      capabilities: { documentTypes: ['01', '03', '07', '08'], voids: true },
    });
  if (path.endsWith('/creation-options'))
    return respond([
      {
        id: `issuer-${organizationId}`,
        ruc: '20100066603',
        legalName: 'Estudio Norte SAC',
        series: [],
      },
    ]);
  if (path.endsWith('/workspace/integration'))
    return respond({
      accounts: [],
      keys: keys.filter((key) => key.organizationId === organizationId),
    });
  if (path.endsWith('/sunat-credentials')) {
    if (req.method() === 'PUT') {
      provisioned = body;
      return respond({ configured: true, hasCertificate: true, version: 1 });
    }
    return respond({
      configured: Boolean(provisioned),
      hasCertificate: Boolean(provisioned),
      version: 1,
    });
  }
  if (path.endsWith('/service-accounts')) return respond({ id: `account-${organizationId}` });
  if (path.endsWith('/issuer-grants')) return respond({});
  if (path.endsWith('/api-keys')) {
    keys.push({ id: 'key-1', prefix: 'test-prefix', revoked_at: null, organizationId });
    return respond({ id: 'key-1', apiKey: 'only-in-memory-test-secret' });
  }
  if (path.endsWith('/webhook-subscriptions')) return respond([]);
  return respond({});
});
try {
  await page.goto('http://127.0.0.1:5173/configuracion');
  await page.getByText('Sandbox usa la conexión oficial', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Contraseña SOL', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Crear clave API' }).click();
  await page.getByText('Copia y guarda tu clave', { exact: false }).waitFor();
  assert.equal(await page.locator('textarea').inputValue(), 'only-in-memory-test-secret');
  await page.getByLabel('Empresa y ambiente').selectOption('production');
  await page.getByLabel('Contraseña SOL', { exact: true }).waitFor();
  assert.equal(await page.getByText('Copia y guarda tu clave', { exact: false }).count(), 0);
  assert.equal(await page.getByText('test-prefix').count(), 0);
  await page.getByLabel('Usuario SOL secundario').fill('test-user');
  await page.getByLabel('Contraseña SOL', { exact: true }).fill('test-password');
  await page.getByLabel('Certificado digital P12/PFX').setInputFiles({
    name: 'test.p12',
    mimeType: 'application/x-pkcs12',
    buffer: Buffer.from('test-only'),
  });
  await page.getByLabel('Contraseña del certificado').fill('test-certificate-password');
  await page.getByRole('button', { name: 'Guardar credenciales' }).click();
  await page.getByText('Credenciales guardadas cifradas.', { exact: false }).waitFor();
  assert.equal(provisioned.environment, 'production');
  assert.equal(await page.getByLabel('Contraseña SOL', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('Contraseña del certificado').inputValue(), '');
  assert.equal(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    '{}',
  );
  await mkdir('output/billing-web', { recursive: true });
  await page.screenshot({ path: 'output/billing-web/11-configuracion.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/billing-web/12-configuracion-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(pageErrors, []);
  console.log(
    'PASS: sandbox/production switch clears keys; credentials only in production; secret fields cleared; no browser persistence; mobile layout.',
  );
} finally {
  await browser.close();
}
