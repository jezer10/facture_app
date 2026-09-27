import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('dialog', (dialog) => dialog.accept());
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const screenshots = new URL('../../../output/billing-web/', import.meta.url).pathname;
await mkdir(screenshots, { recursive: true });
const base = process.env.WEB_TEST_URL || 'http://127.0.0.1:5173';
const issuer = {
  id: '44444444-4444-4444-8444-444444444444',
  legalName: 'Estudio Norte SAC',
  ruc: '20123456789',
  series: [{ id: '55555555-5555-4555-8555-555555555555', series: 'F001', documentType: '01' }],
};
const fixture = (i, status = 'accepted') => ({
  id: `invoice-${i}`,
  organizationId: 'org-test',
  issuerId: issuer.id,
  documentType: '01',
  series: 'F001',
  number: String(i),
  issueDate: '2026-09-25',
  currency: 'PEN',
  status,
  customer: {
    legalName: ['Estudio Norte SAC', 'Comercial Andina SAC', 'Soluciones del Pacífico'][i % 3],
    identityNumber: '20123456789',
  },
  lines: [
    {
      description: 'Servicio de diseño web',
      quantity: '1',
      unitValue: '100',
      payableAmount: '118',
    },
  ],
  totals: { payableAmount: '118', taxableAmount: '100', igvAmount: '18' },
});
let authenticated = false;
let mode = 'beta';
let listError = false;
let created = false;
let voided = false;
let attempts = [];
let detailReads = 0;
let listOffsets = [];
await context.route('**/api/v1/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const respond = (json, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  if (path.endsWith('/workspace'))
    return respond({
      id: 'org-test',
      environment: 'sandbox',
      sunat: mode,
      email: 'mailpit',
      fiscalValidity: false,
      canIssue: true,
      message: 'Sandbox · Sin validez fiscal',
      verifiedRecipients: ['test@example.test'],
      capabilities: { documentTypes: ['01', '03', '07', '08'], voids: true, received: false },
    });
  const session = {
    enabled: true,
    authenticated,
    email: 'test@example.test',
    csrfToken: 'test-csrf',
    organizationId: authenticated ? 'org-test' : null,
    organizations: authenticated
      ? [
          {
            id: 'org-test',
            name: 'Organización de prueba',
            role: 'owner',
            environment: 'sandbox',
            companyId: 'company-test',
          },
        ]
      : [],
  };
  if (path.endsWith('/auth/session')) return respond(session);
  if (path.endsWith('/auth/organization')) return respond(session);
  if (path.endsWith('/auth/native/login')) {
    authenticated = true;
    return respond({ step: 'authenticated' });
  }
  if (path.endsWith('/auth/login')) {
    authenticated = true;
    return route.fulfill({ status: 302, headers: { location: `${base}/conexion?login=success` } });
  }
  if (path.endsWith('/auth/logout')) {
    authenticated = false;
    return respond({ url: `${base}/conexion` });
  }
  assert.equal(request.headers().authorization, undefined);
  if (request.method() === 'POST') assert.equal(request.headers()['x-csrf-token'], 'test-csrf');
  if (path.endsWith('/creation-options')) return respond([issuer]);
  if (path.endsWith('/void-requests')) {
    assert.equal(request.postDataJSON().reason, 'Error de datos');
    voided = true;
    return respond(fixture(42, 'void_pending'), 202);
  }
  if (path.includes('/artifacts/')) return respond({ url: `${base}/test-file.pdf` });
  if (path.endsWith('/fiscal-documents') && request.method() === 'POST') {
    attempts.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
    if (attempts.length === 1) return respond({ message: 'Respuesta temporal de prueba' }, 503);
    created = true;
    return respond(
      { id: 'invoice-42', series: 'F001', number: '42', documentType: '01', status: 'queued' },
      202,
    );
  }
  if (path.endsWith('/fiscal-documents')) {
    if (listError) return respond({ message: 'Error de prueba' }, 500);
    if (url.searchParams.get('limit') === '1') return respond([fixture(1)]);
    const offset = Number(url.searchParams.get('offset') || '0');
    listOffsets.push(offset);
    const status = url.searchParams.get('status');
    return respond(
      status
        ? [fixture(3, status)]
        : Array.from({ length: offset === 0 ? 21 : 2 }, (_, i) =>
            fixture(offset + i + 1, ['accepted', 'processing', 'rejected'][i % 3]),
          ),
    );
  }
  if (path.includes('/fiscal-documents/')) {
    detailReads++;
    return respond(
      fixture(42, voided ? 'voided' : created && detailReads === 1 ? 'queued' : 'accepted'),
    );
  }
  return respond({ message: 'Unknown test route' }, 404);
});
try {
  await page.goto(base);
  await page.getByRole('heading', { name: 'Tu facturación empieza aquí' }).waitFor();
  await page.screenshot({ path: `${screenshots}01-inicio.png`, fullPage: true });
  await page.getByRole('link', { name: 'Conectar mi organización' }).click();
  await page.locator('#access-email').fill('test@example.test');
  await page.locator('#access-password').fill('Example-password-123');
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('button', { name: /Entrar a facturas/ }).click();
  await page.getByRole('link', { name: 'F001-00000001', exact: true }).waitFor();
  await page.screenshot({ path: `${screenshots}02-facturas.png`, fullPage: true });
  await page.getByRole('button', { name: 'Página siguiente' }).click();
  await page.getByRole('link', { name: 'F001-00000021', exact: true }).waitFor();
  assert.ok(listOffsets.includes(20));
  await page.getByRole('button', { name: 'Página anterior' }).click();
  await page.getByLabel('Buscar en esta página').fill('no existe');
  await page.getByRole('heading', { name: 'No encontramos coincidencias' }).waitFor();
  await page.getByLabel('Buscar en esta página').fill('');
  await page.getByLabel('Estado', { exact: true }).selectOption('rejected');
  await page.getByRole('link', { name: 'F001-00000003', exact: true }).waitFor();
  await page.getByLabel('Estado', { exact: true }).selectOption('');
  listError = true;
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await page.getByRole('alert').waitFor();
  listError = false;
  await page.getByRole('button', { name: 'Volver a intentar' }).click();
  await page.getByRole('link', { name: 'F001-00000001', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}03-facturas-mobile.png`, fullPage: true });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'mobile list must not overflow viewport',
  );
  await page.getByRole('link', { name: 'Nuevo comprobante', exact: true }).click();
  await page.locator('input[inputmode="numeric"]').fill('20123456789');
  await page.getByLabel('Razón social').fill('Cliente de prueba SAC');
  await page.getByLabel('Descripción del ítem 1').fill('Servicio de diseño web');
  await page.getByLabel('Valor unitario del ítem 1').fill('100');
  await page.screenshot({ path: `${screenshots}04-nueva-mobile.png`, fullPage: true });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'mobile form must not overflow viewport',
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${screenshots}05-nueva.png`, fullPage: true });
  await page.getByRole('button', { name: 'Emitir comprobante', exact: true }).click();
  await page.getByRole('button', { name: 'Reintentar mismo envío' }).waitFor();
  assert.equal(await page.getByLabel('Razón social').isDisabled(), true);
  await page.getByRole('button', { name: 'Reintentar mismo envío' }).click();
  await page.getByRole('heading', { name: 'F001-00000042' }).waitFor();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].key, attempts[1].key);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(attempts[0].body.lines[0].unitValue, '100');
  assert.equal(attempts[0].body.lines[0].taxRate, '0.18');
  await page.getByText('Aceptada', { exact: true }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${screenshots}06-detalle.png`, fullPage: true });
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Descargar PDF' }).click();
  const popup = await popupPromise;
  await popup.waitForURL('**/test-file.pdf');
  await popup.close();
  await page.getByRole('button', { name: 'Solicitar anulación', exact: true }).click();
  await page.getByLabel('Motivo').fill('Error de datos');
  await page.getByRole('button', { name: 'Confirmar solicitud' }).click();
  await page.getByText('Anulada', { exact: true }).waitFor();
  mode = 'beta';
  await page.getByRole('link', { name: 'Volver a comprobantes' }).click();
  await page.getByRole('link', { name: 'Nuevo comprobante', exact: true }).click();
  await page.getByText('Este comprobante se enviará a SUNAT beta', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Cantidad del ítem 1').getAttribute('readonly'), null);
  assert.equal(await page.getByLabel('Moneda', { exact: true }).isDisabled(), false);
  await page.getByRole('button', { name: 'Agregar ítem' }).click();
  await page.getByLabel('Cantidad del ítem 2').fill('3');
  await page.getByLabel('Tipo de comprobante').selectOption('03');
  await page.getByRole('option', { name: 'DNI', exact: true }).waitFor({ state: 'attached' });
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  assert.ok(!storage.includes('browser-test-token'));
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Tu espacio de facturación' }).waitFor();
  await page.goto(`${base}/facturas`);
  await page.getByRole('heading', { name: 'Tu facturación empieza aquí' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: connection, pagination, search, status filter, error recovery, responsive list/form, safe issuance retry, status polling, download, void, sandbox multi-line and document types, credential isolation.',
  );
} finally {
  await browser.close();
}
