import Decimal from 'decimal.js';

import { SunatValidationError } from '../domain/errors/sunat.error';
import {
  type FiscalDocumentSnapshot,
  type FiscalDocumentType,
  type FiscalLineSnapshot,
  type FiscalPartySnapshot,
  type FiscalTaxSnapshot,
  type ReceivedDocumentSyncRequest,
  SUPPORTED_FISCAL_DOCUMENT_TYPES,
} from '../domain/models/fiscal-document';

const MAX_SYNC_DAYS = 15;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export function parseFiscalDocumentSnapshot(
  value: unknown,
  context: { readonly documentId?: string } = {},
): FiscalDocumentSnapshot {
  const source = requireRecord(value, 'SUNAT_INVALID_DOCUMENT_SNAPSHOT');
  const documentType = requireDocumentType(source.documentType);
  const lines = parseLines(source.lines);
  const totals = optionalRecord(source.totals);
  const snapshot: FiscalDocumentSnapshot = {
    documentId: requireText(source.documentId ?? context.documentId, 'documentId'),
    documentType,
    series: requirePattern(source.series, 'series', /^[A-Z0-9-]{1,20}$/),
    number: requirePattern(source.number, 'number', /^\d{1,20}$/),
    issueDate: requireIsoDate(source.issueDate, 'issueDate'),
    currencyCode: requirePattern(
      source.currencyCode ?? source.currency,
      'currencyCode',
      /^[A-Z]{3}$/,
    ),
    issuer: parseParty(source.issuer, 'issuer', true),
    recipient: parseParty(source.recipient ?? source.customer, 'recipient', false),
    lines,
    taxTotal: requireNonNegativeDecimal(source.taxTotal ?? totals.igvAmount, 'taxTotal'),
    lineExtensionTotal: requireNonNegativeDecimal(
      source.lineExtensionTotal ?? sumLineExtensions(lines),
      'lineExtensionTotal',
    ),
    payableTotal: requireNonNegativeDecimal(
      source.payableTotal ?? totals.payableAmount,
      'payableTotal',
    ),
  };

  const reference = source.reference ?? source.noteReference;
  if (documentType === '07' || documentType === '08') {
    snapshot.reference = parseReference(reference);
  } else if (reference !== undefined && reference !== null) {
    throw invalid('reference', 'sólo se admite para notas 07 y 08');
  }

  return snapshot;
}

export function parseReceivedDocumentSyncRequest(value: unknown): ReceivedDocumentSyncRequest {
  const source = requireRecord(value, 'SUNAT_INVALID_SYNC_REQUEST');
  const dateFrom = requireIsoDate(source.dateFrom ?? source.startDate, 'dateFrom');
  const dateTo = requireIsoDate(source.dateTo ?? source.endDate, 'dateTo');
  const from = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const to = Date.parse(`${dateTo}T00:00:00.000Z`);
  const inclusiveDays = (to - from) / DAY_MILLISECONDS + 1;
  if (inclusiveDays < 1 || inclusiveDays > MAX_SYNC_DAYS) {
    throw invalid('dateRange', `debe contener entre 1 y ${MAX_SYNC_DAYS} días inclusivos`);
  }

  if (!Array.isArray(source.documentTypes) || source.documentTypes.length === 0) {
    throw invalid('documentTypes', 'debe contener al menos un tipo fiscal');
  }

  const documentTypes = [...new Set(source.documentTypes.map(requireDocumentType))];
  const documentSource =
    source.source === undefined ? '2' : requirePattern(source.source, 'source', /^\d+$/);

  return {
    syncId: requireText(source.syncId, 'syncId'),
    dateFrom,
    dateTo,
    documentTypes,
    source: documentSource,
  };
}

function parseLines(value: unknown): FiscalLineSnapshot[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('lines', 'debe contener al menos una línea');
  }

  const ids = new Set<string>();
  return value.map((line, index) => {
    const path = `lines[${index}]`;
    const source = requireRecord(line, 'SUNAT_INVALID_DOCUMENT_LINE');
    const id = requireText(source.id ?? source.lineId, `${path}.id`);
    if (ids.has(id)) {
      throw invalid(`${path}.id`, 'está duplicado');
    }
    ids.add(id);
    const lineExtensionAmount = lineExtension(source, path);

    return {
      id,
      description: requireText(source.description, `${path}.description`),
      quantity: requirePositiveDecimal(source.quantity, `${path}.quantity`),
      unitCode: requirePattern(source.unitCode ?? 'NIU', `${path}.unitCode`, /^[A-Z0-9]{1,10}$/),
      unitPrice: requireNonNegativeDecimal(
        source.unitPrice ?? source.netUnitValue ?? source.unitValue,
        `${path}.unitPrice`,
      ),
      lineExtensionAmount,
      tax: parseTax(source.tax, source, path, lineExtensionAmount),
    };
  });
}

function parseTax(
  value: unknown,
  line: Record<string, unknown>,
  path: string,
  lineExtensionAmount: string,
): FiscalTaxSnapshot {
  const source = value === undefined ? line : requireRecord(value, 'SUNAT_INVALID_TAX');
  return {
    schemeId: requireText(
      source.schemeId ?? taxSchemeId(line.taxAffectation),
      `${path}.tax.schemeId`,
    ),
    schemeName: requireText(
      source.schemeName ?? taxSchemeName(line.taxAffectation),
      `${path}.tax.schemeName`,
    ),
    taxAmount: requireNonNegativeDecimal(
      source.taxAmount ?? source.igvAmount ?? '0',
      `${path}.tax.taxAmount`,
    ),
    taxableAmount: requireNonNegativeDecimal(
      source.taxableAmount ?? lineExtensionAmount,
      `${path}.tax.taxableAmount`,
    ),
  };
}

function parseParty(value: unknown, path: string, mustBeRuc: boolean): FiscalPartySnapshot {
  const source = requireRecord(value, 'SUNAT_INVALID_PARTY');
  const documentNumber = requirePattern(
    source.documentNumber ?? source.identityNumber ?? source.ruc,
    `${path}.documentNumber`,
    mustBeRuc ? /^\d{11}$/ : /^[A-Z0-9-]{1,20}$/,
  );
  return {
    documentType: requirePattern(
      source.documentType ?? source.identityType ?? (mustBeRuc ? '6' : undefined),
      `${path}.documentType`,
      /^[A-Z0-9]{1,2}$/,
    ),
    documentNumber,
    legalName: requireText(source.legalName, `${path}.legalName`),
  };
}

function parseReference(value: unknown): NonNullable<FiscalDocumentSnapshot['reference']> {
  const source = requireRecord(value, 'SUNAT_INVALID_NOTE_REFERENCE');
  const referencedDocument = optionalRecord(source.document);
  const documentType = requireText(
    source.documentType ?? referencedDocument.documentType,
    'reference.documentType',
  );
  if (documentType !== '01' && documentType !== '03') {
    throw invalid('reference.documentType', 'debe ser 01 o 03');
  }
  const series = source.series ?? referencedDocument.series;
  const number = source.number ?? referencedDocument.number;
  const id =
    source.id === undefined
      ? `${requireText(series, 'reference.series')}-${requireText(number, 'reference.number')}`
      : requireText(source.id, 'reference.id');
  return {
    documentType,
    id,
    reasonCode: requireText(source.reasonCode, 'reference.reasonCode'),
    reasonDescription: requireText(
      source.reasonDescription ?? source.reason,
      'reference.reasonDescription',
    ),
  };
}

function lineExtension(source: Record<string, unknown>, path: string): string {
  if (source.lineExtensionAmount !== undefined) {
    return requireNonNegativeDecimal(source.lineExtensionAmount, `${path}.lineExtensionAmount`);
  }
  const candidates = [source.taxableAmount, source.exoneratedAmount, source.unaffectedAmount];
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }
    const amount = requireNonNegativeDecimal(candidate, `${path}.lineExtensionAmount`);
    if (!new Decimal(amount).isZero()) {
      return amount;
    }
  }
  return '0.00';
}

function sumLineExtensions(lines: readonly FiscalLineSnapshot[]): string {
  return lines
    .reduce((total, line) => total.plus(line.lineExtensionAmount), new Decimal(0))
    .toFixed(2);
}

function taxSchemeId(taxAffectation: unknown): string {
  switch (taxAffectation) {
    case 'exonerated':
      return '9997';
    case 'unaffected':
      return '9998';
    case 'free':
      return '9996';
    default:
      return '1000';
  }
}

function taxSchemeName(taxAffectation: unknown): string {
  return taxAffectation === 'taxed' ? 'IGV' : 'INA';
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireDocumentType(value: unknown): FiscalDocumentType {
  const normalized = requireText(value, 'documentType').toUpperCase();
  if (!SUPPORTED_FISCAL_DOCUMENT_TYPES.includes(normalized as FiscalDocumentType)) {
    throw invalid('documentType', 'debe ser 01, 03, 07 u 08');
  }
  return normalized as FiscalDocumentType;
}

function requireIsoDate(value: unknown, path: string): string {
  const text = requirePattern(value, path, /^\d{4}-\d{2}-\d{2}$/);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw invalid(path, 'debe ser una fecha real en formato AAAA-MM-DD');
  }
  return text;
}

function requirePositiveDecimal(value: unknown, path: string): string {
  const text = requireNonNegativeDecimal(value, path);
  if (/^0(?:\.0+)?$/.test(text)) {
    throw invalid(path, 'debe ser mayor que cero');
  }
  return text;
}

function requireNonNegativeDecimal(value: unknown, path: string): string {
  return requirePattern(value, path, /^(?:0|[1-9]\d*)(?:\.\d+)?$/);
}

function requirePattern(value: unknown, path: string, pattern: RegExp): string {
  const text = requireText(value, path);
  if (!pattern.test(text)) {
    throw invalid(path, 'tiene un formato inválido');
  }
  return text;
}

function requireText(value: unknown, path: string): string {
  if (value === null || value === undefined) {
    throw invalid(path, 'es obligatorio');
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw invalid(path, 'debe ser texto o número');
  }
  const text = `${value}`.trim();
  if (!text) {
    throw invalid(path, 'no puede estar vacío');
  }
  return text;
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SunatValidationError(code, 'El payload fiscal tiene un formato inválido.');
  }
  return value as Record<string, unknown>;
}

function invalid(path: string, reason: string): SunatValidationError {
  return new SunatValidationError('SUNAT_INVALID_PAYLOAD', `El campo ${path} ${reason}.`);
}
