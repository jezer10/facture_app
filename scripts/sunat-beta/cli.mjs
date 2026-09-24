#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  BETA_URL,
  betaSchema,
  buildBetaInvoice,
  signBetaInvoice,
  packageInvoice,
  betaEnvelope,
  parseBetaResponse,
  sendToBeta,
} from './protocol.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      send: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.config) {
    console.log(
      'Uso: pnpm sunat:beta --config <archivo.json> [--send]\nSin --send prepara y verifica XML/ZIP localmente. --send realiza un único envío a SUNAT beta.\nNunca emite en producción. No solicita ni utiliza claves SOL reales.',
    );
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (process.env.NODE_ENV === 'production')
    throw new Error('Este comando es exclusivo de desarrollo beta');
  const config = betaSchema.parse(JSON.parse(readFileSync(resolve(values.config), 'utf8')));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const outputRoot = resolve(root, 'output/sunat-beta');
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(resolve(outputRoot, 'run-'));
  const write = (name, data) => writeFileSync(resolve(directory, name), data, { mode: 0o600 });
  const privateKey = resolve(directory, 'beta-private.key');
  const certificate = resolve(directory, 'beta-certificate.pem');
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
      '2',
      '-subj',
      '/CN=FACTURE BETA ONLY/O=TEST CERTIFICATE',
      '-keyout',
      privateKey,
      '-out',
      certificate,
    ],
    { stdio: 'pipe' },
  );
  const invoice = buildBetaInvoice(config);
  const signedXml = signBetaInvoice(
    invoice.xml,
    readFileSync(privateKey),
    readFileSync(certificate),
  );
  const zip = packageInvoice(invoice.fileBase, signedXml);
  write('input.json', JSON.stringify(config, null, 2));
  write(`${invoice.fileBase}.xml`, signedXml);
  write(`${invoice.fileBase}.zip`, zip);
  const report = {
    mode: 'sunat-beta-no-fiscal-validity',
    endpoint: BETA_URL,
    sent: false,
    signatureVerifiedLocally: true,
    certificate: 'self-signed-beta-only',
    cdrSignatureVerified: false,
    documentId: invoice.documentId,
    total: invoice.total,
    xmlSha256: createHash('sha256').update(signedXml).digest('hex'),
    directory,
  };
  write('result.json', JSON.stringify(report, null, 2));
  if (values.send) {
    report.sent = true;
    report.status = 'sending';
    write('result.json', JSON.stringify(report, null, 2));
    try {
      const response = await sendToBeta(betaEnvelope(config.issuer.ruc, invoice.fileBase, zip));
      report.httpStatus = response.httpStatus;
      write('soap-response.xml', response.body);
      const outcome = parseBetaResponse(response.body, invoice.documentId, invoice.fileBase);
      if (response.httpStatus !== 200 && outcome.status !== 'soap_fault') {
        throw new Error(`Respuesta CDR con estado HTTP inesperado: ${response.httpStatus}`);
      }
      const { cdrZip, cdrXml, ...summary } = outcome;
      if (cdrZip) write(`R-${invoice.fileBase}.zip`, cdrZip);
      if (cdrXml) write(`R-${invoice.fileBase}.xml`, cdrXml);
      Object.assign(report, summary);
      if (outcome.status !== 'accepted_beta' || response.httpStatus !== 200) process.exitCode = 1;
    } catch (error) {
      report.status = 'unconfirmed';
      report.error = error.message;
      process.exitCode = 1;
    }
  } else {
    report.status = 'prepared_locally';
  }
  write('result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
