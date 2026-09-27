import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let mode = 'found',
  calls = 0;
await page.route('**/api/v1/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  const respond = (data, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (path.endsWith('/auth/session'))
    return respond({ enabled: true, authenticated: true, csrfToken: 'test', organizations: [] });
  if (path.endsWith('/health/mode')) return respond({ sunat: 'mock', fiscalValidity: false });
  if (path.endsWith('/company-registrations')) return respond([]);
  if (path.includes('/taxpayer-registry/')) {
    calls++;
    if (mode === 'error') return respond({ message: 'Unavailable' }, 503);
    if (mode === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    return respond({
      found: mode !== 'missing',
      source: 'SUNAT',
      sourceDate: '2026-09-25',
      stale: false,
      ...(mode === 'missing'
        ? {}
        : {
            taxpayer: {
              ruc: path.split('/').at(-1),
              legalName: 'COMPAÑÍA PERÚ',
              address: 'AV. PRUEBA 123',
              status: 'ACTIVO',
              condition: 'HABIDO',
              ubigeo: '150101',
            },
          }),
    });
  }
  return respond({}, 404);
});
try {
  await page.goto('http://127.0.0.1:5173/empresas');
  await page.getByRole('button', { name: 'Registrar mi empresa', exact: true }).click();
  await page.locator('#company-ruc').fill('20131312950');
  await page.waitForTimeout(600);
  assert.equal(calls, 0);
  await page.locator('#company-ruc').fill('20131312955');
  await page.getByText('Datos encontrados en SUNAT', { exact: true }).waitFor();
  assert.equal(await page.locator('#company-name').inputValue(), 'COMPAÑÍA PERÚ');
  assert.equal(await page.locator('#company-address').inputValue(), 'AV. PRUEBA 123');
  await page.getByText('Estado: ACTIVO · Condición: HABIDO', { exact: true }).waitFor();
  mode = 'missing';
  await page.locator('#company-ruc').fill('20100070970');
  await page.getByText('RUC no encontrado en esta copia del padrón', { exact: true }).waitFor();
  assert.equal(await page.locator('#company-name').inputValue(), '');
  mode = 'error';
  await page.locator('#company-ruc').fill('20131312955');
  await page.getByRole('button', { name: 'Reintentar consulta' }).waitFor();
  mode = 'found';
  await page.getByRole('button', { name: 'Reintentar consulta' }).click();
  await page.getByText('Datos encontrados en SUNAT', { exact: true }).waitFor();
  mode = 'slow';
  await page.locator('#company-ruc').fill('20100070970');
  await page.getByText('Consultando el padrón de SUNAT…', { exact: true }).waitFor();
  await page.locator('#company-ruc').fill('20');
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#company-name').inputValue(), '');
  assert.equal(await page.getByText('Datos encontrados en SUNAT', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: valid-RUC debounce, autofill, snapshot date, missing entries, retry and stale-response cancellation.',
  );
} finally {
  await browser.close();
}
