import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import {
  betaSchema,
  buildBetaInvoice,
  signBetaInvoice,
  verifySignature,
  packageInvoice,
  betaEnvelope,
  parseBetaResponse,
  parseXml,
  sendToBeta,
  BETA_URL,
} from './protocol.mjs';

const input = JSON.parse(readFileSync(new URL('./example.json', import.meta.url), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'facture-beta-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
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
    '1',
    '-subj',
    '/CN=TEST ONLY',
    '-keyout',
    join(dir, 'test.key'),
    '-out',
    join(dir, 'test.pem'),
  ],
  { stdio: 'pipe' },
);
const key = readFileSync(join(dir, 'test.key'));
const cert = readFileSync(join(dir, 'test.pem'));
const invoice = buildBetaInvoice(input);

test('rejects production, extra endpoints, invalid RUC, date and amount', () => {
  for (const bad of [
    { ...input, environment: 'production' },
    { ...input, endpoint: 'https://example.com' },
    { ...input, issuer: { ...input.issuer, ruc: '20100066600' } },
    { ...input, issueDate: '2026-02-30' },
    { ...input, netAmount: '0.00' },
  ])
    assert.throws(() => betaSchema.parse(bad));
});
test('escapes user content and calculates decimal tax', () => {
  const built = buildBetaInvoice({ ...input, description: 'Web & <portal>', netAmount: '100.03' });
  assert.equal(built.total, '118.04');
  assert.match(built.xml, /Web &amp; &lt;portal&gt;/u);
  assert.doesNotThrow(() => parseXml(built.xml));
});
test('signs the whole invoice and rejects amount tampering', () => {
  const xml = signBetaInvoice(invoice.xml, key, cert);
  assert.equal(verifySignature(xml, cert), true);
  assert.equal(verifySignature(xml.replace('100.00', '999.00'), cert), false);
  assert.match(xml, /URI=""/u);
});
test('ZIP contains exactly the signed invoice, SOAP uses only beta credentials', () => {
  const signed = signBetaInvoice(invoice.xml, key, cert);
  const zip = packageInvoice(invoice.fileBase, signed);
  const files = unzipSync(zip);
  assert.deepEqual(Object.keys(files), [invoice.fileBase + '.xml']);
  assert.equal(Buffer.from(files[invoice.fileBase + '.xml']).toString(), signed);
  const soap = betaEnvelope(input.issuer.ruc, invoice.fileBase, zip);
  assert.match(soap, /20100066603MODDATOS/u);
  assert.match(soap, /<wsse:Password>MODDATOS<\/wsse:Password>/u);
});

const cbc = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const cac = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
function soapResponse(code = '0', id = invoice.documentId) {
  const xml = `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:b="${cbc}" xmlns:a="${cac}"><a:DocumentResponse><a:Response><b:ResponseCode>${code}</b:ResponseCode><b:Description>Respuesta de prueba</b:Description></a:Response><a:DocumentReference><b:ID>${id}</b:ID></a:DocumentReference></a:DocumentResponse></ApplicationResponse>`;
  const zip = zipSync({ [`R-${invoice.fileBase}.xml`]: Buffer.from(xml) });
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><sendBillResponse><applicationResponse>${Buffer.from(zip).toString('base64')}</applicationResponse></sendBillResponse></s:Body></s:Envelope>`;
}
test('reads CDR by namespace, distinguishes acceptance and rejection', () => {
  assert.equal(
    parseBetaResponse(soapResponse(), invoice.documentId, invoice.fileBase).status,
    'accepted_beta',
  );
  assert.equal(
    parseBetaResponse(soapResponse('2335'), invoice.documentId, invoice.fileBase).status,
    'rejected_beta',
  );
  assert.throws(
    () => parseBetaResponse(soapResponse('0', 'FB01-999'), invoice.documentId, invoice.fileBase),
    /otro comprobante/u,
  );
});
test('preserves SOAP faults and rejects HTML and entity declarations', () => {
  const fault =
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>soap:Client.0100</faultcode><faultstring>Error de autenticación</faultstring></s:Fault></s:Body></s:Envelope>';
  assert.equal(parseBetaResponse(fault, invoice.documentId, invoice.fileBase).status, 'soap_fault');
  assert.throws(() => parseBetaResponse('<html/>', invoice.documentId, invoice.fileBase));
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'));
});
test('network target is fixed beta, no redirects and no implicit retries', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, BETA_URL);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.SOAPAction, 'urn:sendBill');
    return new Response(soapResponse(), { status: 200 });
  });
  await sendToBeta('<test/>');
  assert.equal(calls, 1);
});
