import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Decimal from 'decimal.js';

// Restored byte-for-byte from 185de78; styles are local because the PDF browser
// disables scripts and networking.
const original = readFileSync(resolve('src/assets/templates/index.html'), 'utf8');
const styles = readFileSync(resolve('src/assets/styles/output.css'), 'utf8');

export function renderOriginalInvoice(snapshot: Record<string, unknown>): string {
  const issuer = record(snapshot.issuer);
  const customer = record(snapshot.customer ?? snapshot.receiver);
  const totals = record(snapshot.totals);
  const currency = text(snapshot.currency ?? snapshot.iso_currency_code) || 'PEN';
  const originalSummary = record(snapshot.summary);
  const lines = array(snapshot.lines ?? snapshot.items);
  const lineDiscounts = lines.reduce(
    (sum, line) => sum.plus(text(line.discountAmount) || '0'),
    new Decimal(0),
  );
  const summaryFields: Record<string, string> = {
    global_affected_discount: 'globalAffectedDiscount',
    total_taxed_sales_value: 'taxableAmount',
    total_unaffected_sales_value: 'unaffectedAmount',
    total_exonerated_sales_value: 'exoneratedAmount',
    total_free_sales_value: 'freeAmount',
    total_exportation_sales_value: 'exportAmount',
    global_unaffected_discount: 'globalUnaffectedDiscount',
    total_discount: 'discountAmount',
    other_taxes_addition: 'otherTaxesAmount',
    other_charges_addition: 'otherChargesAmount',
    isc_addition: 'iscAmount',
    igv_addition: 'igvAmount',
    icbper_addition: 'icbperAmount',
    total_advance_amount: 'advanceAmount',
    rounded_amount: 'roundingAmount',
    total: 'payableAmount',
  };
  const summary = Object.fromEntries(
    Object.entries(summaryFields).map(([old, current]) => [
      old,
      money(originalSummary[old] ?? totals[current]),
    ]),
  );
  if (originalSummary.total_discount === undefined && totals.discountAmount === undefined) {
    summary.total_discount = lineDiscounts.toFixed(2);
  }
  const data = {
    issuer: {
      comercial_name: issuer.tradeName ?? issuer.comercial_name,
      name: issuer.legalName ?? issuer.name,
      address: address(issuer.address),
      location: issuer.location ?? location(issuer.address),
      ruc: issuer.ruc,
    },
    receiver: {
      name: customer.legalName ?? customer.name,
      ruc: customer.identityNumber ?? customer.ruc,
      address: address(customer.address),
    },
    issue_date: snapshot.issueDate ?? snapshot.issue_date,
    serial_number: snapshot.series ?? snapshot.serial_number,
    document_number: snapshot.number ?? snapshot.document_number,
    comment: snapshot.notes ?? snapshot.comment,
    total_amount_text:
      snapshot.totalAmountText ??
      snapshot.total_amount_text ??
      amountInWords(summary.total ?? '0.00', currency),
    items: lines.map((line) => ({
      quantity: line.quantity,
      measure: line.unitCode ?? line.measure,
      code: line.itemCode ?? line.code,
      description: line.description,
      unit_value: text(line.unitValue ?? line.referenceUnitValue ?? line.unit_value),
      icbper: money(line.icbperAmount ?? line.icbper),
    })),
    summary,
    detraction: array(snapshot.detraction),
  };
  const labels: Record<string, string> = {
    '01': 'FACTURA ELECTRÓNICA',
    '03': 'BOLETA ELECTRÓNICA',
    '07': 'NOTA DE CRÉDITO',
    '08': 'NOTA DE DÉBITO',
  };
  const label = labels[text(snapshot.documentType)] ?? 'FACTURA ELECTRÓNICA';
  const identityLabel = customer.identityType === '1' ? 'DNI' : 'RUC';
  const template = original
    .replace('<script src="https://cdn.tailwindcss.com"></script>', `<style>${styles}</style>`)
    .replace('FACTURA ELECTRÓNICA', label)
    .replace('<td>RUC</td>', `<td>${identityLabel}</td>`)
    .replace('<td>SOL</td>', `<td>${escape(currency === 'PEN' ? 'SOL' : currency)}</td>`)
    .replaceAll(
      'S/ {{',
      `${escape(currency === 'PEN' ? 'S/' : currency === 'USD' ? '$' : currency)} {{`,
    );
  return interpolate(template, data);
}

// Only the placeholders and flat loops present in the recovered template are
// supported. User values are escaped once and never interpreted as templates.
function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(
    /\{% for item in (items|detraction) %\}([\s\S]*?)\{% endfor %\}|\{\{\s*([\w.]+)\s*\}\}/gu,
    (_match, collection: string | undefined, body: string, path: string) => {
      if (collection)
        return array(data[collection])
          .map((item) => interpolate(body, { ...data, item }))
          .join('');
      let value: unknown = data;
      for (const part of path.split('.')) {
        const object = record(value);
        value = Object.hasOwn(object, part) ? object[part] : undefined;
      }
      return escape(text(value));
    },
  );
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function money(value: unknown): string {
  const amount = text(value);
  return amount ? new Decimal(amount).toFixed(2) : '0.00';
}
function address(value: unknown): string {
  const object = record(value);
  return typeof value === 'string' ? value : text(object.line ?? object.street ?? object.address);
}
function location(value: unknown): string {
  const object = record(value);
  return [object.district, object.province, object.department]
    .map(text)
    .filter(Boolean)
    .join(' - ');
}
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function amountInWords(amount: string, currency: string): string {
  const [integer = '0', cents = '00'] = amount.split('.');
  const n = Number(integer);
  if (!Number.isSafeInteger(n) || n < 0 || n >= 1_000_000_000_000) return `${amount} ${currency}`;
  const units = [
    'CERO',
    'UNO',
    'DOS',
    'TRES',
    'CUATRO',
    'CINCO',
    'SEIS',
    'SIETE',
    'OCHO',
    'NUEVE',
    'DIEZ',
    'ONCE',
    'DOCE',
    'TRECE',
    'CATORCE',
    'QUINCE',
    'DIECISÉIS',
    'DIECISIETE',
    'DIECIOCHO',
    'DIECINUEVE',
    'VEINTE',
    'VEINTIUNO',
    'VEINTIDÓS',
    'VEINTITRÉS',
    'VEINTICUATRO',
    'VEINTICINCO',
    'VEINTISÉIS',
    'VEINTISIETE',
    'VEINTIOCHO',
    'VEINTINUEVE',
  ];
  const apocopate = (word: string): string =>
    word.replace(/VEINTIUNO$/u, 'VEINTIÚN').replace(/UNO$/u, 'UN');
  const words = (value: number): string => {
    if (value < 30) return units[value]!;
    if (value < 100)
      return (
        [
          '',
          '',
          '',
          'TREINTA',
          'CUARENTA',
          'CINCUENTA',
          'SESENTA',
          'SETENTA',
          'OCHENTA',
          'NOVENTA',
        ][Math.floor(value / 10)]! + (value % 10 ? ` Y ${words(value % 10)}` : '')
      );
    if (value === 100) return 'CIEN';
    if (value < 1000)
      return (
        [
          '',
          'CIENTO',
          'DOSCIENTOS',
          'TRESCIENTOS',
          'CUATROCIENTOS',
          'QUINIENTOS',
          'SEISCIENTOS',
          'SETECIENTOS',
          'OCHOCIENTOS',
          'NOVECIENTOS',
        ][Math.floor(value / 100)]! + (value % 100 ? ` ${words(value % 100)}` : '')
      );
    if (value < 1_000_000)
      return (
        (value < 2000 ? 'MIL' : `${apocopate(words(Math.floor(value / 1000)))} MIL`) +
        (value % 1000 ? ` ${words(value % 1000)}` : '')
      );
    return (
      (value < 2_000_000
        ? 'UN MILLÓN'
        : `${apocopate(words(Math.floor(value / 1_000_000)))} MILLONES`) +
      (value % 1_000_000 ? ` ${words(value % 1_000_000)}` : '')
    );
  };
  return `${apocopate(words(n))} CON ${cents}/100 ${currency === 'PEN' ? 'SOLES' : currency === 'USD' ? 'DÓLARES AMERICANOS' : currency}`;
}
