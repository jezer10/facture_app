import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let authenticated = false;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/v1/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  const respond = (data, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (path.endsWith('/health/mode')) return respond({ sunat: 'mock', fiscalValidity: false });
  if (path.endsWith('/auth/session'))
    return respond({
      enabled: true,
      authenticated,
      email: 'test@example.test',
      csrfToken: 'test',
      organizations: [],
    });
  if (path.includes('/auth/native/')) {
    const body = route.request().postDataJSON();
    assert.equal(route.request().headers().authorization, undefined);
    if (path.endsWith('/register')) {
      assert.equal(body.password, 'Example-Password-123');
      return respond({ step: 'confirm', message: 'Revisa tu correo.' });
    }
    if (path.endsWith('/confirm'))
      return body.code === '123456'
        ? respond({ step: 'login', message: 'Correo verificado.' })
        : respond({ message: 'Código no válido.' }, 400);
    if (path.endsWith('/forgot'))
      return respond({ step: 'reset', message: 'Si existe la cuenta, recibirás un código.' });
    if (path.endsWith('/reset'))
      return respond({ step: 'login', message: 'Contraseña actualizada.' });
    if (path.endsWith('/login'))
      return respond({ step: 'challenge', challenge: 'SOFTWARE_TOKEN_MFA' });
    if (path.endsWith('/challenge')) {
      assert.equal(body.code, '123456');
      authenticated = true;
      return respond({ step: 'authenticated' });
    }
  }
  return respond({}, 404);
});
try {
  await page.goto('http://127.0.0.1:5173/conexion');
  await page.locator('#access-email').waitFor();
  await page.screenshot({ path: 'output/billing-web/12-login-vue.png', fullPage: true });
  await page.getByRole('button', { name: 'Crear una cuenta' }).click();
  await page.locator('#access-email').fill('test@example.test');
  await page.locator('#access-password').fill('Example-Password-123');
  await page.locator('#access-repeat').fill('Wrong-password-123');
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
  await page.getByText('Las contraseñas no coinciden.').waitFor();
  await page.locator('#access-repeat').fill('Example-Password-123');
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
  await page.locator('#access-code').fill('000000');
  await page.getByRole('button', { name: 'Verificar correo', exact: true }).click();
  await page.getByText('Código no válido.').waitFor();
  await page.locator('#access-code').fill('123456');
  await page.getByRole('button', { name: 'Verificar correo', exact: true }).click();
  await page.getByText('Correo verificado.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Olvidé mi contraseña' }).click();
  await page.getByRole('button', { name: 'Enviar código', exact: true }).click();
  await page.locator('#access-code').fill('123456');
  await page.locator('#access-password').fill('Example-Password-123');
  await page.locator('#access-repeat').fill('Example-Password-123');
  await page.getByRole('button', { name: 'Cambiar contraseña', exact: true }).click();
  await page.getByText('Contraseña actualizada.', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'output/billing-web/13-login-vue-mobile.png', fullPage: true });
  await page.locator('#access-password').fill('Example-Password-123');
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.locator('#access-code').fill('123456');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.getByText('Hola, test@example.test', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => ({ ...localStorage })), {});
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Vue registration, password confirmation, email verification, recovery, MFA, mobile layout and no browser token storage.',
  );
} finally {
  await browser.close();
}
