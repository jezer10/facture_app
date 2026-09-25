const { DOMParser } = require('@xmldom/xmldom');
const Decimal = require('decimal.js');
const { unzipSync, zipSync } = require('fflate');
const { SignedXml } = require('xml-crypto');
const { z } = require('zod');

const BETA_URL = 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const MAX_BYTES = 2 * 1024 * 1024;
const ruc = z
  .string()
  .regex(/^20\d{9}$/u)
  .refine((value) => {
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const check =
      (11 - (weights.reduce((sum, weight, i) => sum + weight * Number(value[i]), 0) % 11)) % 10;
    return check === Number(value[10]);
  }, 'RUC con dígito verificador inválido');
const label = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value));
const betaSchema = z
  .object({
    environment: z.literal('beta'),
    issuer: z.object({ ruc, legalName: label }).strict(),
    customer: z.object({ ruc, legalName: label }).strict(),
    series: z
      .string()
      .regex(/^F[A-Z0-9]{3}$/u)
      .default('FB01'),
    number: z.string().regex(/^[1-9]\d{0,7}$/u),
    issueDate: z.iso.date(),
    description: label,
    netAmount: z
      .string()
      .regex(/^\d{1,4}\.\d{2}$/u)
      .refine(
        (v) => new Decimal(v).gt(0) && new Decimal(v).lte(500),
        'La prueba admite un valor neto de hasta S/ 500',
      ),
  })
  .strict();

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildBetaInvoice(input) {
  const c = betaSchema.parse(input);
  const net = new Decimal(c.netAmount);
  const tax = net.mul('0.18').toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const total = net.plus(tax).toFixed(2);
  const money = (name, value) => `<cbc:${name} currencyID="PEN">${value}</cbc:${name}>`;
  const scheme =
    '<cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme>';
  const taxTotal = (line = false) =>
    `<cac:TaxTotal>${money('TaxAmount', tax.toFixed(2))}<cac:TaxSubtotal>${money('TaxableAmount', net.toFixed(2))}${money('TaxAmount', tax.toFixed(2))}<cac:TaxCategory>${line ? '<cbc:Percent>18</cbc:Percent><cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode>' : ''}${scheme}</cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>`;
  const party = (tag, p, supplier = false) =>
    `<cac:${tag}><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">${p.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${xmlEscape(p.legalName)}</cbc:RegistrationName>${supplier ? '<cac:RegistrationAddress><cbc:AddressTypeCode>0000</cbc:AddressTypeCode></cac:RegistrationAddress>' : ''}</cac:PartyLegalEntity></cac:Party></cac:${tag}>`;
  const id = `${c.series}-${c.number}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="${CAC}" xmlns:cbc="${CBC}" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID>
<cbc:ID>${id}</cbc:ID><cbc:IssueDate>${c.issueDate}</cbc:IssueDate><cbc:IssueTime>12:00:00</cbc:IssueTime>
<cbc:InvoiceTypeCode listID="0101">01</cbc:InvoiceTypeCode>
<cbc:Note>PRUEBA SUNAT BETA - SIN VALIDEZ FISCAL</cbc:Note>
<cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode><cbc:LineCountNumeric>1</cbc:LineCountNumeric>
<cac:Signature><cbc:ID>beta-signature</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${c.issuer.ruc}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${xmlEscape(c.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#beta-signature</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>
${party('AccountingSupplierParty', c.issuer, true)}${party('AccountingCustomerParty', c.customer)}
<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>
${taxTotal()}
<cac:LegalMonetaryTotal>${money('LineExtensionAmount', net.toFixed(2))}${money('TaxInclusiveAmount', total)}${money('PayableAmount', total)}</cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="ZZ">1</cbc:InvoicedQuantity>${money('LineExtensionAmount', net.toFixed(2))}<cac:PricingReference><cac:AlternativeConditionPrice>${money('PriceAmount', total)}<cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference>${taxTotal(true)}<cac:Item><cbc:Description>${xmlEscape(c.description)}</cbc:Description></cac:Item><cac:Price>${money('PriceAmount', net.toFixed(2))}</cac:Price></cac:InvoiceLine>
</Invoice>`;
  return { xml, documentId: id, fileBase: `${c.issuer.ruc}-01-${id}`, total };
}

function parseXml(xml) {
  if (Buffer.byteLength(xml) > MAX_BYTES || /<!DOCTYPE|<!ENTITY/iu.test(xml))
    throw new Error('XML no permitido o demasiado grande');
  return new DOMParser({
    onError: () => {
      throw new Error('XML inválido');
    },
  }).parseFromString(xml, 'text/xml');
}

function verifySignature(xml, certificate) {
  const doc = parseXml(xml);
  const signatures = doc.getElementsByTagNameNS(DS, 'Signature');
  if (signatures.length !== 1) return false;
  const verifier = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null });
  verifier.loadSignature(signatures[0]);
  return verifier.checkSignature(xml);
}

function signBetaInvoice(xml, privateKey, certificate) {
  const signer = new SignedXml({
    privateKey,
    publicCert: certificate,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });
  signer.addReference({
    xpath: '/*',
    isEmptyUri: true,
    transforms: [DS + 'enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  signer.computeSignature(xml, {
    prefix: 'ds',
    attrs: { Id: 'beta-signature' },
    location: { reference: "//*[local-name()='ExtensionContent']", action: 'append' },
  });
  const signed = signer.getSignedXml();
  if (!verifySignature(signed, certificate))
    throw new Error('La firma XML no pasó su verificación local');
  return signed;
}

function packageInvoice(fileBase, xml) {
  if (!/^20\d{9}-01-F[A-Z0-9]{3}-[1-9]\d{0,7}$/u.test(fileBase))
    throw new Error('Nombre de comprobante inválido');
  return Buffer.from(zipSync({ [`${fileBase}.xml`]: Buffer.from(xml) }));
}

function betaEnvelope(issuerRuc, fileBase, zip) {
  ruc.parse(issuerRuc);
  if (!fileBase.startsWith(`${issuerRuc}-01-`)) throw new Error('RUC y archivo no coinciden');
  return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${SOAP}" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><soap:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${issuerRuc}MODDATOS</wsse:Username><wsse:Password>MODDATOS</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header><soap:Body><ser:sendBill><fileName>${xmlEscape(fileBase)}.zip</fileName><contentFile>${zip.toString('base64')}</contentFile></ser:sendBill></soap:Body></soap:Envelope>`;
}

function parseBetaResponse(xml, documentId, fileBase) {
  const soap = parseXml(xml);
  if (soap.documentElement.namespaceURI !== SOAP || soap.documentElement.localName !== 'Envelope')
    throw new Error('La respuesta no es SOAP 1.1');
  const faults = soap.getElementsByTagNameNS(SOAP, 'Fault');
  if (faults.length) {
    const text = (name) =>
      faults[0].getElementsByTagNameNS('*', name)[0]?.textContent?.trim() ?? '';
    return {
      status: 'soap_fault',
      responseCode: text('faultcode'),
      description: text('faultstring'),
    };
  }
  const responses = soap.getElementsByTagNameNS('*', 'applicationResponse');
  if (responses.length !== 1) throw new Error('SUNAT no devolvió una CDR');
  const encoded = responses[0].textContent.replace(/\s/gu, '');
  const cdrZip = Buffer.from(encoded, 'base64');
  if (!encoded || cdrZip.toString('base64') !== encoded) throw new Error('CDR base64 inválida');
  const expected = `R-${fileBase}.xml`;
  const entries = unzipSync(cdrZip, {
    filter: (entry) => {
      if (entry.originalSize > MAX_BYTES) throw new Error('CDR demasiado grande');
      return entry.name === expected;
    },
  });
  if (!entries[expected]) throw new Error('La CDR no corresponde al archivo enviado');
  const cdrXml = Buffer.from(entries[expected]).toString('utf8');
  const cdr = parseXml(cdrXml);
  if (
    cdr.documentElement.localName !== 'ApplicationResponse' ||
    cdr.documentElement.namespaceURI !==
      'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2'
  )
    throw new Error('Raíz de CDR inválida');
  const documentResponses = cdr.getElementsByTagNameNS(CAC, 'DocumentResponse');
  if (documentResponses.length !== 1) throw new Error('CDR ambigua');
  const response = documentResponses[0].getElementsByTagNameNS(CAC, 'Response')[0];
  const reference = documentResponses[0].getElementsByTagNameNS(CAC, 'DocumentReference')[0];
  const value = (node, name) => node?.getElementsByTagNameNS(CBC, name)[0]?.textContent?.trim();
  if (value(reference, 'ID') !== documentId)
    throw new Error('La CDR corresponde a otro comprobante');
  const responseCode = value(response, 'ResponseCode');
  if (!responseCode || !/^\d+$/u.test(responseCode)) throw new Error('Código de CDR inválido');
  return {
    status: responseCode === '0' ? 'accepted_beta' : 'rejected_beta',
    responseCode,
    description: value(response, 'Description') ?? '',
    observations: Array.from(cdr.getElementsByTagNameNS(CBC, 'Note'), (n) => n.textContent.trim()),
    cdrZip,
    cdrXml,
  };
}

async function sendToBeta(envelope) {
  // Fixed endpoint and no redirects: this pilot cannot be switched to production.
  const response = await fetch(BETA_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: 'urn:sendBill' },
    body: envelope,
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Respuesta SUNAT demasiado grande');
    chunks.push(chunk);
  }
  return { httpStatus: response.status, body: Buffer.concat(chunks).toString('utf8') };
}

module.exports = {
  BETA_URL,
  betaSchema,
  xmlEscape,
  buildBetaInvoice,
  parseXml,
  verifySignature,
  signBetaInvoice,
  packageInvoice,
  betaEnvelope,
  parseBetaResponse,
  sendToBeta,
};
