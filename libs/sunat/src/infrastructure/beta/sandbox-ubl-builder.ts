import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { SunatValidationError } from '../../domain/errors/sunat.error';
import {
  toFiscalDocumentIdentity,
  type FiscalDocumentSnapshot,
  type FiscalLineSnapshot,
  type FiscalPartySnapshot,
} from '../../domain/models/fiscal-document';
import type { UnsignedUblDocument } from '../../domain/models/sunat-outcome';
import type { UblBuilderPort } from '../../domain/ports/ubl-builder.port';

export const xmlEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const amount = (value: string): string => new Decimal(value).toFixed(2);
const elements = {
  '01': ['Invoice', 'InvoiceLine', 'InvoicedQuantity', 'LegalMonetaryTotal'],
  '03': ['Invoice', 'InvoiceLine', 'InvoicedQuantity', 'LegalMonetaryTotal'],
  '07': ['CreditNote', 'CreditNoteLine', 'CreditedQuantity', 'LegalMonetaryTotal'],
  '08': ['DebitNote', 'DebitNoteLine', 'DebitedQuantity', 'RequestedMonetaryTotal'],
} as const;

/** UBL 2.1 for real SUNAT beta submissions. An emitted XML is not an acceptance. */
export class SandboxUblBuilder implements UblBuilderPort {
  build(snapshot: FiscalDocumentSnapshot): UnsignedUblDocument {
    if (snapshot.environment !== 'beta')
      throw new SunatValidationError(
        'SANDBOX_ENVIRONMENT_REQUIRED',
        'Solo documentos de Sandbox pueden enviarse a SUNAT beta.',
      );
    const note = snapshot.documentType === '07' || snapshot.documentType === '08';
    const prefix =
      (note ? snapshot.reference?.documentType : snapshot.documentType) === '03' ? 'B' : 'F';
    if (
      !new RegExp(`^${prefix}[A-Z0-9]{3}$`).test(snapshot.series) ||
      !/^[1-9]\d{0,7}$/.test(snapshot.number)
    )
      throw new SunatValidationError(
        'INVALID_DOCUMENT_SERIES',
        'La serie debe corresponder al tipo de comprobante o a su referencia.',
      );
    if (note && !snapshot.reference)
      throw new SunatValidationError(
        'NOTE_REFERENCE_REQUIRED',
        'La nota necesita el comprobante afectado.',
      );
    const extension = snapshot.lines.reduce(
      (sum, line) => sum.plus(line.lineExtensionAmount),
      new Decimal(0),
    );
    const tax = snapshot.lines.reduce((sum, line) => sum.plus(line.tax.taxAmount), new Decimal(0));
    if (
      !extension.eq(snapshot.lineExtensionTotal) ||
      !tax.eq(snapshot.taxTotal) ||
      !extension.plus(tax).eq(snapshot.payableTotal)
    )
      throw new SunatValidationError(
        'DOCUMENT_TOTAL_MISMATCH',
        'Los importes del comprobante no coinciden.',
      );
    const [root, lineTag, quantityTag, totalTag] = elements[snapshot.documentType];
    const money = (tag: string, value: string): string =>
      `<cbc:${tag} currencyID="${xmlEscape(snapshot.currencyCode)}">${amount(value)}</cbc:${tag}>`;
    const taxScheme = (line: FiscalLineSnapshot): string =>
      `<cac:TaxScheme><cbc:ID>${xmlEscape(line.tax.schemeId)}</cbc:ID><cbc:Name>${xmlEscape(line.tax.schemeName)}</cbc:Name><cbc:TaxTypeCode>${line.tax.schemeId === '1000' ? 'VAT' : 'OTH'}</cbc:TaxTypeCode></cac:TaxScheme>`;
    const taxCategory = (line: FiscalLineSnapshot, detail: boolean): string =>
      `<cac:TaxCategory>${detail ? `<cbc:Percent>${line.tax.percent ?? (line.tax.schemeId === '1000' ? '18' : '0')}</cbc:Percent><cbc:TaxExemptionReasonCode>${line.tax.affectationCode ?? { '1000': '10', '9997': '20', '9998': '30' }[line.tax.schemeId] ?? '10'}</cbc:TaxExemptionReasonCode>` : ''}${taxScheme(line)}</cac:TaxCategory>`;
    const taxSubtotal = (line: FiscalLineSnapshot, detail: boolean): string =>
      `<cac:TaxSubtotal>${money('TaxableAmount', line.tax.taxableAmount)}${money('TaxAmount', line.tax.taxAmount)}${taxCategory(line, detail)}</cac:TaxSubtotal>`;
    const groups = new Map<string, FiscalLineSnapshot>();
    for (const line of snapshot.lines) {
      if (!['1000', '9997', '9998'].includes(line.tax.schemeId))
        throw new SunatValidationError(
          'UNSUPPORTED_TAX_SCHEME',
          'Esta operación tributaria aún no tiene un XML validado en Sandbox.',
        );
      const prior = groups.get(line.tax.schemeId);
      groups.set(
        line.tax.schemeId,
        prior
          ? {
              ...line,
              tax: {
                ...line.tax,
                taxableAmount: new Decimal(prior.tax.taxableAmount)
                  .plus(line.tax.taxableAmount)
                  .toFixed(2),
                taxAmount: new Decimal(prior.tax.taxAmount).plus(line.tax.taxAmount).toFixed(2),
              },
            }
          : line,
      );
    }
    const party = (tag: string, p: FiscalPartySnapshot, supplier = false): string =>
      `<cac:${tag}><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${xmlEscape(p.documentType)}">${xmlEscape(p.documentNumber)}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${xmlEscape(p.legalName)}</cbc:RegistrationName>${supplier ? '<cac:RegistrationAddress><cbc:AddressTypeCode>0000</cbc:AddressTypeCode></cac:RegistrationAddress>' : ''}</cac:PartyLegalEntity></cac:Party></cac:${tag}>`;
    const reference = snapshot.reference;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID>
<cbc:ID>${snapshot.series}-${snapshot.number}</cbc:ID><cbc:IssueDate>${xmlEscape(snapshot.issueDate)}</cbc:IssueDate>
${note ? '' : `<cbc:InvoiceTypeCode listID="0101">${snapshot.documentType}</cbc:InvoiceTypeCode>`}
<cbc:Note>SANDBOX - SIN VALIDEZ FISCAL</cbc:Note><cbc:DocumentCurrencyCode>${xmlEscape(snapshot.currencyCode)}</cbc:DocumentCurrencyCode>
${reference ? `<cac:DiscrepancyResponse><cbc:ReferenceID>${xmlEscape(reference.id)}</cbc:ReferenceID><cbc:ResponseCode>${xmlEscape(reference.reasonCode)}</cbc:ResponseCode><cbc:Description>${xmlEscape(reference.reasonDescription)}</cbc:Description></cac:DiscrepancyResponse><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${xmlEscape(reference.id)}</cbc:ID><cbc:DocumentTypeCode>${reference.documentType}</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}
<cac:Signature><cbc:ID>beta-signature</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${snapshot.issuer.documentNumber}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${xmlEscape(snapshot.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#beta-signature</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>
${party('AccountingSupplierParty', snapshot.issuer, true)}${party('AccountingCustomerParty', snapshot.recipient)}
${snapshot.documentType === '01' ? '<cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>' : ''}
<cac:TaxTotal>${money('TaxAmount', snapshot.taxTotal)}${[...groups.values()].map((line) => taxSubtotal(line, false)).join('')}</cac:TaxTotal>
<cac:${totalTag}>${money('LineExtensionAmount', snapshot.lineExtensionTotal)}${money('TaxInclusiveAmount', snapshot.payableTotal)}${money('PayableAmount', snapshot.payableTotal)}</cac:${totalTag}>
${snapshot.lines.map((line) => `<cac:${lineTag}><cbc:ID>${xmlEscape(line.id)}</cbc:ID><cbc:${quantityTag} unitCode="${xmlEscape(line.unitCode)}">${line.quantity}</cbc:${quantityTag}>${money('LineExtensionAmount', line.lineExtensionAmount)}<cac:PricingReference><cac:AlternativeConditionPrice>${money('PriceAmount', new Decimal(line.lineExtensionAmount).plus(line.tax.taxAmount).div(line.quantity).toFixed(10))}<cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference><cac:TaxTotal>${money('TaxAmount', line.tax.taxAmount)}${taxSubtotal(line, true)}</cac:TaxTotal><cac:Item><cbc:Description>${xmlEscape(line.description)}</cbc:Description></cac:Item><cac:Price><cbc:PriceAmount currencyID="${snapshot.currencyCode}">${line.unitPrice}</cbc:PriceAmount></cac:Price></cac:${lineTag}>`).join('\n')}
</${root}>`;
    return {
      identity: toFiscalDocumentIdentity(snapshot),
      xml,
      sha256: createHash('sha256').update(xml).digest('hex'),
    };
  }
}
