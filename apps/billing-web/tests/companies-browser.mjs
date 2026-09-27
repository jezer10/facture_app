import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let records = [];
await context.route('**/api/v1/**', async (route) => {
  const req = route.request(),
    url = new URL(req.url());
  const respond = (data, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (url.pathname.endsWith('/auth/session'))
    return respond({
      enabled: true,
      authenticated: true,
      email: 'test@example.test',
      csrfToken: 'csrf-test',
      organizations: [],
      organizationId: null,
    });
  if (url.pathname.endsWith('/health/mode'))
    return respond({ sunat: 'mock', fiscalValidity: false });
  if (req.method() !== 'GET') assert.equal(req.headers()['x-csrf-token'], 'csrf-test');
  if (url.pathname.endsWith('/company-registrations')) return respond(records);
  const id = url.pathname.split('/')[4];
  if (req.method() === 'PUT') {
    const record = {
      id,
      status: 'draft',
      data: req.postDataJSON(),
      organization_id: null,
      decision_note: null,
    };
    records = [record];
    return respond(record);
  }
  if (url.pathname.endsWith('/submit')) {
    records[0].status = 'pending';
    return respond(records[0]);
  }
  return respond({ message: 'Unexpected API request' }, 404);
});
try {
  await page.goto('http://127.0.0.1:5173/empresas');
  await page.getByRole('button', { name: 'Registrar mi empresa', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  assert.equal(await page.locator('[aria-invalid="true"]').count(), 3);
  await page.locator('#company-ruc').fill('20131312955');
  await page.locator('#company-name').fill('Empresa de prueba SAC');
  await page.locator('#company-address').fill('Av. Prueba 123, Lima');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await page.getByLabel('Tu nombre completo').fill('Persona de prueba');
  await page.getByLabel('Tu relación con la empresa').selectOption('representative');
  await page
    .getByLabel('¿Cómo podemos comprobar tu autorización?')
    .fill('Representante inscrito, sujeto a verificación independiente.');
  await page.getByRole('button', { name: 'Guardar y salir' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Continuar registro' }).click();
  assert.equal(await page.locator('#company-name').inputValue(), 'Empresa de prueba SAC');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await page.locator('#invoice-series').fill('B001');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  assert.equal(await page.locator('[aria-invalid="true"]').count(), 1);
  await page.locator('#invoice-series').fill('F001');
  await page.getByRole('button', { name: 'Guardar y continuar' }).click();
  await page.getByRole('button', { name: 'Enviar a revisión' }).click();
  assert.equal(records[0].status, 'draft');
  await mkdir('output/billing-web', { recursive: true });
  await page.screenshot({ path: 'output/billing-web/09-empresa-resumen.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/billing-web/10-empresa-movil.png', fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Enviar a revisión' }).click();
  await page.getByText('En revisión', { exact: true }).waitFor();
  assert.equal(records[0].status, 'pending');
  assert.equal(await page.getByRole('button', { name: 'Abrir empresa' }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: validation, drafts restored, review declaration, pending restrictions, mobile layout, no organization required.',
  );
} finally {
  await browser.close();
}
