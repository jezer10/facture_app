import Decimal from 'decimal.js';
import type { FiscalDocumentSnapshot } from '../../domain/models/fiscal-document';
import { xmlEscape as esc } from './sandbox-ubl-builder';

export function buildVoidXml(
  snapshot: FiscalDocumentSnapshot,
  reason: string,
  date: string,
  sequence: string,
): { id: string; file: string; xml: string } {
  const summary = snapshot.series.startsWith('B');
  const root = summary ? 'SummaryDocuments' : 'VoidedDocuments';
  const id = `${summary ? 'RC' : 'RA'}-${date.replaceAll('-', '')}-${sequence}`;
  const money = (tag: string, value: string): string =>
    `<cbc:${tag} currencyID="${snapshot.currencyCode}">${value}</cbc:${tag}>`;
  const groups = new Map<string, { base: Decimal; tax: Decimal }>();
  for (const line of snapshot.lines) {
    const group = groups.get(line.tax.schemeId) ?? { base: new Decimal(0), tax: new Decimal(0) };
    group.base = group.base.plus(line.lineExtensionAmount);
    group.tax = group.tax.plus(line.tax.taxAmount);
    groups.set(line.tax.schemeId, group);
  }
  const schemes: Record<string, { payment: string; name: string; type: string }> = {
    '1000': { payment: '01', name: 'IGV', type: 'VAT' },
    '9997': { payment: '02', name: 'EXO', type: 'VAT' },
    '9998': { payment: '03', name: 'INA', type: 'FRE' },
  };
  const payments = [...groups]
    .map(([id, group]) => {
      const scheme = schemes[id];
      if (!scheme) throw new Error('Régimen tributario no soportado para el resumen beta.');
      return `<sac:BillingPayment>${money('PaidAmount', group.base.toFixed(2))}<cbc:InstructionID>${scheme.payment}</cbc:InstructionID></sac:BillingPayment>`;
    })
    .join('');
  const taxes = [...groups]
    .map(([id, group]) => {
      const scheme = schemes[id];
      if (!scheme) throw new Error('Régimen tributario no soportado para el resumen beta.');
      return `<cac:TaxSubtotal>${money('TaxAmount', group.tax.toFixed(2))}<cac:TaxCategory><cac:TaxScheme><cbc:ID>${id}</cbc:ID><cbc:Name>${scheme.name}</cbc:Name><cbc:TaxTypeCode>${scheme.type}</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
    })
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:${root}-1" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>${summary ? '1.1' : '1.0'}</cbc:CustomizationID><cbc:ID>${id}</cbc:ID><cbc:ReferenceDate>${snapshot.issueDate}</cbc:ReferenceDate><cbc:IssueDate>${date}</cbc:IssueDate>
<cac:Signature><cbc:ID>beta-signature</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${snapshot.issuer.documentNumber}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${esc(snapshot.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#beta-signature</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>
<cac:AccountingSupplierParty><cbc:CustomerAssignedAccountID>${snapshot.issuer.documentNumber}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>6</cbc:AdditionalAccountID><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>${esc(snapshot.issuer.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
${summary ? `<sac:SummaryDocumentsLine><cbc:LineID>1</cbc:LineID><cbc:DocumentTypeCode>${snapshot.documentType}</cbc:DocumentTypeCode><cbc:ID>${snapshot.series}-${snapshot.number}</cbc:ID><cac:AccountingCustomerParty><cbc:CustomerAssignedAccountID>${snapshot.recipient.documentNumber}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>${snapshot.recipient.documentType}</cbc:AdditionalAccountID></cac:AccountingCustomerParty>${snapshot.reference ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(snapshot.reference.id)}</cbc:ID><cbc:DocumentTypeCode>${snapshot.reference.documentType}</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}<cac:Status><cbc:ConditionCode>3</cbc:ConditionCode></cac:Status><sac:TotalAmount currencyID="${snapshot.currencyCode}">${snapshot.payableTotal}</sac:TotalAmount>${payments}<cac:TaxTotal>${money('TaxAmount', snapshot.taxTotal)}${taxes}</cac:TaxTotal></sac:SummaryDocumentsLine>` : `<sac:VoidedDocumentsLine><cbc:LineID>1</cbc:LineID><cbc:DocumentTypeCode>${snapshot.documentType}</cbc:DocumentTypeCode><sac:DocumentSerialID>${snapshot.series}</sac:DocumentSerialID><sac:DocumentNumberID>${snapshot.number}</sac:DocumentNumberID><sac:VoidReasonDescription>${esc(reason)}</sac:VoidReasonDescription></sac:VoidedDocumentsLine>`}
</${root}>`;
  return { id, file: `${snapshot.issuer.documentNumber}-${id}`, xml };
}
