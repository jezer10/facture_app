import { createHash } from 'node:crypto';

import type { FiscalDocumentSnapshot } from '../../domain/models/fiscal-document';
import { toFiscalDocumentIdentity } from '../../domain/models/fiscal-document';
import type { UnsignedUblDocument } from '../../domain/models/sunat-outcome';
import type { UblBuilderPort } from '../../domain/ports/ubl-builder.port';

interface UblElementNames {
  root: 'Invoice' | 'CreditNote' | 'DebitNote';
  rootNamespace: string;
  line: 'InvoiceLine' | 'CreditNoteLine' | 'DebitNoteLine';
  quantity: 'InvoicedQuantity' | 'CreditedQuantity' | 'DebitedQuantity';
  monetaryTotal: 'LegalMonetaryTotal' | 'RequestedMonetaryTotal';
}

const DOCUMENT_ELEMENTS: Record<FiscalDocumentSnapshot['documentType'], UblElementNames> = {
  '01': {
    root: 'Invoice',
    rootNamespace: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    line: 'InvoiceLine',
    quantity: 'InvoicedQuantity',
    monetaryTotal: 'LegalMonetaryTotal',
  },
  '03': {
    root: 'Invoice',
    rootNamespace: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    line: 'InvoiceLine',
    quantity: 'InvoicedQuantity',
    monetaryTotal: 'LegalMonetaryTotal',
  },
  '07': {
    root: 'CreditNote',
    rootNamespace: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
    line: 'CreditNoteLine',
    quantity: 'CreditedQuantity',
    monetaryTotal: 'LegalMonetaryTotal',
  },
  '08': {
    root: 'DebitNote',
    rootNamespace: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
    line: 'DebitNoteLine',
    quantity: 'DebitedQuantity',
    monetaryTotal: 'RequestedMonetaryTotal',
  },
};

/**
 * Generates the deterministic UBL 2.1 subset used at the SUNAT boundary.
 * Official XSD/catalog validation remains mandatory before enabling a direct
 * production provider.
 */
export class DeterministicUblBuilder implements UblBuilderPort {
  build(snapshot: FiscalDocumentSnapshot): UnsignedUblDocument {
    const names = DOCUMENT_ELEMENTS[snapshot.documentType];
    const documentId = `${snapshot.series}-${snapshot.number}`;
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<${names.root} xmlns="${names.rootNamespace}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">`,
      '  <ext:UBLExtensions>',
      '    <ext:UBLExtension>',
      '      <ext:ExtensionContent/>',
      '    </ext:UBLExtension>',
      '  </ext:UBLExtensions>',
      '  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>',
      '  <cbc:CustomizationID>2.0</cbc:CustomizationID>',
      `  <cbc:ID>${escapeXml(documentId)}</cbc:ID>`,
      `  <cbc:IssueDate>${escapeXml(snapshot.issueDate)}</cbc:IssueDate>`,
      ...(snapshot.documentType === '01' || snapshot.documentType === '03'
        ? [`  <cbc:InvoiceTypeCode>${snapshot.documentType}</cbc:InvoiceTypeCode>`]
        : buildNoteReference(snapshot)),
      `  <cbc:DocumentCurrencyCode>${escapeXml(snapshot.currencyCode)}</cbc:DocumentCurrencyCode>`,
      ...buildParty('AccountingSupplierParty', snapshot.issuer),
      ...buildParty('AccountingCustomerParty', snapshot.recipient),
      ...buildTaxTotal(snapshot),
      ...buildMonetaryTotal(snapshot, names.monetaryTotal),
      ...snapshot.lines.flatMap((line) => buildLine(snapshot, names, line)),
      `</${names.root}>`,
      '',
    ].join('\n');

    return {
      identity: toFiscalDocumentIdentity(snapshot),
      xml: body,
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    };
  }
}

function buildNoteReference(snapshot: FiscalDocumentSnapshot): string[] {
  const reference = snapshot.reference;
  if (!reference) {
    return [];
  }
  return [
    '  <cac:DiscrepancyResponse>',
    `    <cbc:ReferenceID>${escapeXml(reference.id)}</cbc:ReferenceID>`,
    `    <cbc:ResponseCode>${escapeXml(reference.reasonCode)}</cbc:ResponseCode>`,
    `    <cbc:Description>${escapeXml(reference.reasonDescription)}</cbc:Description>`,
    '  </cac:DiscrepancyResponse>',
    '  <cac:BillingReference>',
    '    <cac:InvoiceDocumentReference>',
    `      <cbc:ID>${escapeXml(reference.id)}</cbc:ID>`,
    `      <cbc:DocumentTypeCode>${reference.documentType}</cbc:DocumentTypeCode>`,
    '    </cac:InvoiceDocumentReference>',
    '  </cac:BillingReference>',
  ];
}

function buildParty(
  element: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  party: FiscalDocumentSnapshot['issuer'],
): string[] {
  return [
    `  <cac:${element}>`,
    '    <cac:Party>',
    '      <cac:PartyTaxScheme>',
    `        <cbc:RegistrationName>${escapeXml(party.legalName)}</cbc:RegistrationName>`,
    `        <cbc:CompanyID schemeID="${escapeXml(party.documentType)}">${escapeXml(party.documentNumber)}</cbc:CompanyID>`,
    '        <cac:TaxScheme>',
    '          <cbc:ID>SUNAT</cbc:ID>',
    '        </cac:TaxScheme>',
    '      </cac:PartyTaxScheme>',
    '    </cac:Party>',
    `  </cac:${element}>`,
  ];
}

function buildTaxTotal(snapshot: FiscalDocumentSnapshot): string[] {
  return [
    '  <cac:TaxTotal>',
    `    <cbc:TaxAmount currencyID="${snapshot.currencyCode}">${snapshot.taxTotal}</cbc:TaxAmount>`,
    '  </cac:TaxTotal>',
  ];
}

function buildMonetaryTotal(
  snapshot: FiscalDocumentSnapshot,
  element: UblElementNames['monetaryTotal'],
): string[] {
  return [
    `  <cac:${element}>`,
    `    <cbc:LineExtensionAmount currencyID="${snapshot.currencyCode}">${snapshot.lineExtensionTotal}</cbc:LineExtensionAmount>`,
    `    <cbc:PayableAmount currencyID="${snapshot.currencyCode}">${snapshot.payableTotal}</cbc:PayableAmount>`,
    `  </cac:${element}>`,
  ];
}

function buildLine(
  snapshot: FiscalDocumentSnapshot,
  names: UblElementNames,
  line: FiscalDocumentSnapshot['lines'][number],
): string[] {
  return [
    `  <cac:${names.line}>`,
    `    <cbc:ID>${escapeXml(line.id)}</cbc:ID>`,
    `    <cbc:${names.quantity} unitCode="${escapeXml(line.unitCode)}">${line.quantity}</cbc:${names.quantity}>`,
    `    <cbc:LineExtensionAmount currencyID="${snapshot.currencyCode}">${line.lineExtensionAmount}</cbc:LineExtensionAmount>`,
    '    <cac:TaxTotal>',
    `      <cbc:TaxAmount currencyID="${snapshot.currencyCode}">${line.tax.taxAmount}</cbc:TaxAmount>`,
    '      <cac:TaxSubtotal>',
    `        <cbc:TaxableAmount currencyID="${snapshot.currencyCode}">${line.tax.taxableAmount}</cbc:TaxableAmount>`,
    `        <cbc:TaxAmount currencyID="${snapshot.currencyCode}">${line.tax.taxAmount}</cbc:TaxAmount>`,
    '        <cac:TaxCategory>',
    '          <cac:TaxScheme>',
    `            <cbc:ID>${escapeXml(line.tax.schemeId)}</cbc:ID>`,
    `            <cbc:Name>${escapeXml(line.tax.schemeName)}</cbc:Name>`,
    '          </cac:TaxScheme>',
    '        </cac:TaxCategory>',
    '      </cac:TaxSubtotal>',
    '    </cac:TaxTotal>',
    '    <cac:Item>',
    `      <cbc:Description>${escapeXml(line.description)}</cbc:Description>`,
    '    </cac:Item>',
    '    <cac:Price>',
    `      <cbc:PriceAmount currencyID="${snapshot.currencyCode}">${line.unitPrice}</cbc:PriceAmount>`,
    '    </cac:Price>',
    `  </cac:${names.line}>`,
  ];
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
