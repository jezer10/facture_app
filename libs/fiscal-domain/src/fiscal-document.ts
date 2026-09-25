import type Decimal from 'decimal.js';

import { canonicalDecimal, FiscalDecimal, Money, parseDecimal } from './money';
import type { DecimalValue } from './money';

export const FISCAL_DOCUMENT_TYPES = ['01', '03', '07', '08'] as const;
export type FiscalDocumentType = (typeof FISCAL_DOCUMENT_TYPES)[number];
export type OriginalDocumentType = Extract<FiscalDocumentType, '01' | '03'>;
export type NoteDocumentType = Extract<FiscalDocumentType, '07' | '08'>;

export const DEFAULT_IGV_RATE = '0.18';

export type TaxCategory = 'TAXED' | 'EXONERATED' | 'UNAFFECTED' | 'FREE';
export type FreeTaxTreatment = Exclude<TaxCategory, 'FREE'>;

interface BaseFiscalLineInput {
  readonly lineId: string;
  readonly description: string;
  readonly quantity: DecimalValue;
}

export interface TaxedLineInput extends BaseFiscalLineInput {
  readonly taxCategory: 'TAXED';
  /** Net unit value before IGV. Defaults to the current v1 rate of 18%. */
  readonly unitValue: DecimalValue;
  readonly igvRate?: DecimalValue;
}

export interface ExoneratedLineInput extends BaseFiscalLineInput {
  readonly taxCategory: 'EXONERATED';
  readonly unitValue: DecimalValue;
}

export interface UnaffectedLineInput extends BaseFiscalLineInput {
  readonly taxCategory: 'UNAFFECTED';
  readonly unitValue: DecimalValue;
}

export interface FreeLineInput extends BaseFiscalLineInput {
  readonly taxCategory: 'FREE';
  readonly freeTaxTreatment: FreeTaxTreatment;
  readonly referenceUnitValue: DecimalValue;
  readonly igvRate?: DecimalValue;
}

export type FiscalLineInput =
  | TaxedLineInput
  | ExoneratedLineInput
  | UnaffectedLineInput
  | FreeLineInput;

export interface ReferencedFiscalDocument {
  readonly documentType: OriginalDocumentType;
  readonly series: string;
  readonly number: string;
}

export interface NoteReference {
  readonly document: ReferencedFiscalDocument;
  readonly reasonCode: string;
  readonly reason: string;
}

export interface FiscalDocumentInput {
  readonly documentType: FiscalDocumentType;
  readonly currency: string;
  readonly issueDate: string;
  readonly lines: readonly FiscalLineInput[];
  readonly noteReference?: NoteReference;
}

export type FiscalValidationCode =
  | 'INVALID_DOCUMENT_TYPE'
  | 'INVALID_CURRENCY'
  | 'INVALID_ISSUE_DATE'
  | 'LINES_REQUIRED'
  | 'INVALID_LINE_ID'
  | 'DUPLICATE_LINE_ID'
  | 'INVALID_DESCRIPTION'
  | 'INVALID_QUANTITY'
  | 'INVALID_UNIT_VALUE'
  | 'INVALID_IGV_RATE'
  | 'INVALID_TAX_CATEGORY'
  | 'INVALID_FREE_TREATMENT'
  | 'INVALID_REFERENCE_UNIT_VALUE'
  | 'NOTE_REFERENCE_REQUIRED'
  | 'NOTE_REFERENCE_NOT_ALLOWED'
  | 'INVALID_NOTE_REFERENCE';

export interface FiscalValidationIssue {
  readonly code: FiscalValidationCode;
  readonly path: string;
  readonly message: string;
}

export class FiscalValidationError extends Error {
  public readonly issues: readonly FiscalValidationIssue[];

  constructor(issues: readonly FiscalValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'FiscalValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

export interface CalculatedFiscalLine {
  readonly lineId: string;
  readonly description: string;
  readonly quantity: string;
  readonly taxCategory: TaxCategory;
  readonly freeTaxTreatment?: FreeTaxTreatment;
  readonly unitValue?: string;
  readonly referenceUnitValue?: string;
  readonly igvRate?: string;
  readonly taxableAmount: Money;
  readonly exoneratedAmount: Money;
  readonly unaffectedAmount: Money;
  readonly freeAmount: Money;
  /** IGV belonging to onerous operations and included in the payable amount. */
  readonly igvAmount: Money;
  /** Informative IGV calculated for free taxed operations. */
  readonly freeIgvAmount: Money;
  readonly payableAmount: Money;
}

export interface FiscalDocumentTotals {
  readonly taxableAmount: Money;
  readonly exoneratedAmount: Money;
  readonly unaffectedAmount: Money;
  readonly freeAmount: Money;
  readonly igvAmount: Money;
  readonly freeIgvAmount: Money;
  readonly payableAmount: Money;
}

export interface CalculatedFiscalDocument {
  readonly documentType: FiscalDocumentType;
  readonly currency: string;
  readonly issueDate: string;
  readonly noteReference?: Readonly<NoteReference>;
  readonly lines: readonly CalculatedFiscalLine[];
  readonly totals: FiscalDocumentTotals;
}

export function validateFiscalDocument(
  input: FiscalDocumentInput,
): readonly FiscalValidationIssue[] {
  const issues: FiscalValidationIssue[] = [];

  validateHeader(input, issues);
  validateNoteReference(input, issues);

  const lines: readonly FiscalLineInput[] = Array.isArray(input.lines)
    ? (input.lines as readonly FiscalLineInput[])
    : [];
  if (lines.length === 0) {
    issues.push(issue('LINES_REQUIRED', 'lines', 'at least one line is required'));
    return Object.freeze(issues);
  }

  const lineIds = new Set<string>();
  lines.forEach((line, index) => {
    validateLine(line, index, lineIds, issues);
  });

  return Object.freeze(issues);
}

export function calculateFiscalDocument(input: FiscalDocumentInput): CalculatedFiscalDocument {
  const issues = validateFiscalDocument(input);
  if (issues.length > 0) {
    throw new FiscalValidationError(issues);
  }

  const lines = Object.freeze(input.lines.map((line) => calculateLine(line, input.currency)));
  const totals = sumTotals(lines, input.currency);
  const noteReference = input.noteReference ? freezeNoteReference(input.noteReference) : undefined;

  return Object.freeze({
    documentType: input.documentType,
    currency: input.currency,
    issueDate: input.issueDate,
    ...(noteReference ? { noteReference } : {}),
    lines,
    totals,
  });
}

function validateHeader(input: FiscalDocumentInput, issues: FiscalValidationIssue[]): void {
  if (!FISCAL_DOCUMENT_TYPES.includes(input.documentType)) {
    issues.push(issue('INVALID_DOCUMENT_TYPE', 'documentType', 'must be one of 01, 03, 07 or 08'));
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    issues.push(issue('INVALID_CURRENCY', 'currency', 'must be an ISO 4217 code'));
  }
  if (!isIsoCalendarDate(input.issueDate)) {
    issues.push(
      issue('INVALID_ISSUE_DATE', 'issueDate', 'must be a real calendar date in YYYY-MM-DD format'),
    );
  }
}

function validateNoteReference(input: FiscalDocumentInput, issues: FiscalValidationIssue[]): void {
  const isNote = input.documentType === '07' || input.documentType === '08';
  if (isNote && !input.noteReference) {
    issues.push(
      issue(
        'NOTE_REFERENCE_REQUIRED',
        'noteReference',
        'credit and debit notes require an original document reference',
      ),
    );
    return;
  }
  if (!isNote && input.noteReference) {
    issues.push(
      issue(
        'NOTE_REFERENCE_NOT_ALLOWED',
        'noteReference',
        'only credit and debit notes may include a note reference',
      ),
    );
    return;
  }
  if (!input.noteReference) {
    return;
  }

  const reference = input.noteReference;
  if (
    !['01', '03'].includes(reference.document.documentType) ||
    !isNonBlank(reference.document.series) ||
    !isNonBlank(reference.document.number) ||
    !isNonBlank(reference.reasonCode) ||
    !isNonBlank(reference.reason)
  ) {
    issues.push(
      issue(
        'INVALID_NOTE_REFERENCE',
        'noteReference',
        'requires an original 01/03 document, series, number, reason code and reason',
      ),
    );
  }
}

function validateLine(
  line: FiscalLineInput,
  index: number,
  lineIds: Set<string>,
  issues: FiscalValidationIssue[],
): void {
  const path = `lines[${index}]`;

  if (!isNonBlank(line.lineId)) {
    issues.push(issue('INVALID_LINE_ID', `${path}.lineId`, 'must not be blank'));
  } else if (lineIds.has(line.lineId.trim())) {
    issues.push(issue('DUPLICATE_LINE_ID', `${path}.lineId`, 'must be unique within the document'));
  } else {
    lineIds.add(line.lineId.trim());
  }

  if (!isNonBlank(line.description)) {
    issues.push(issue('INVALID_DESCRIPTION', `${path}.description`, 'must not be blank'));
  }
  validatePositiveDecimal(line.quantity, `${path}.quantity`, 'INVALID_QUANTITY', issues);

  switch (line.taxCategory) {
    case 'TAXED':
      validateNonNegativeDecimal(line.unitValue, `${path}.unitValue`, 'INVALID_UNIT_VALUE', issues);
      validateIgvRate(line.igvRate, path, issues);
      break;
    case 'EXONERATED':
    case 'UNAFFECTED':
      validateNonNegativeDecimal(line.unitValue, `${path}.unitValue`, 'INVALID_UNIT_VALUE', issues);
      break;
    case 'FREE':
      if (!['TAXED', 'EXONERATED', 'UNAFFECTED'].includes(line.freeTaxTreatment)) {
        issues.push(
          issue(
            'INVALID_FREE_TREATMENT',
            `${path}.freeTaxTreatment`,
            'must be TAXED, EXONERATED or UNAFFECTED',
          ),
        );
      }
      validatePositiveDecimal(
        line.referenceUnitValue,
        `${path}.referenceUnitValue`,
        'INVALID_REFERENCE_UNIT_VALUE',
        issues,
      );
      if (line.freeTaxTreatment === 'TAXED') {
        validateIgvRate(line.igvRate, path, issues);
      } else if (line.igvRate !== undefined) {
        issues.push(
          issue('INVALID_IGV_RATE', `${path}.igvRate`, 'is only valid for taxed operations'),
        );
      }
      break;
    default:
      issues.push(
        issue(
          'INVALID_TAX_CATEGORY',
          `${path}.taxCategory`,
          'must be TAXED, EXONERATED, UNAFFECTED or FREE',
        ),
      );
  }
}

function validateIgvRate(
  value: DecimalValue | undefined,
  linePath: string,
  issues: FiscalValidationIssue[],
): void {
  const rate = value ?? DEFAULT_IGV_RATE;
  const parsed = tryParseDecimal(rate);
  if (!parsed || !parsed.greaterThan(0) || parsed.greaterThan(1)) {
    issues.push(issue('INVALID_IGV_RATE', `${linePath}.igvRate`, 'must be between 0 and 1'));
  }
}

function validatePositiveDecimal(
  value: DecimalValue,
  path: string,
  code: FiscalValidationCode,
  issues: FiscalValidationIssue[],
): void {
  const parsed = tryParseDecimal(value);
  if (!parsed || !parsed.greaterThan(0)) {
    issues.push(issue(code, path, 'must be a finite decimal greater than zero'));
  }
}

function validateNonNegativeDecimal(
  value: DecimalValue,
  path: string,
  code: FiscalValidationCode,
  issues: FiscalValidationIssue[],
): void {
  const parsed = tryParseDecimal(value);
  if (!parsed || parsed.isNegative()) {
    issues.push(issue(code, path, 'must be a finite non-negative decimal'));
  }
}

function calculateLine(line: FiscalLineInput, currency: string): CalculatedFiscalLine {
  const zero = Money.zero(currency);
  const quantity = parseDecimal(line.quantity, 'quantity');

  switch (line.taxCategory) {
    case 'TAXED': {
      const unitValue = parseDecimal(line.unitValue, 'unitValue');
      const taxableAmount = Money.of(quantity.times(unitValue), currency);
      const igvRate = normalizedIgvRate(line.igvRate);
      const igvAmount = Money.of(taxableAmount.toDecimal().times(igvRate), currency);
      return Object.freeze({
        ...baseCalculatedLine(line, quantity, currency),
        unitValue: canonicalDecimal(unitValue),
        igvRate: canonicalDecimal(igvRate),
        taxableAmount,
        igvAmount,
        payableAmount: taxableAmount.add(igvAmount),
      });
    }
    case 'EXONERATED': {
      const unitValue = parseDecimal(line.unitValue, 'unitValue');
      const exoneratedAmount = Money.of(quantity.times(unitValue), currency);
      return Object.freeze({
        ...baseCalculatedLine(line, quantity, currency),
        unitValue: canonicalDecimal(unitValue),
        exoneratedAmount,
        payableAmount: exoneratedAmount,
      });
    }
    case 'UNAFFECTED': {
      const unitValue = parseDecimal(line.unitValue, 'unitValue');
      const unaffectedAmount = Money.of(quantity.times(unitValue), currency);
      return Object.freeze({
        ...baseCalculatedLine(line, quantity, currency),
        unitValue: canonicalDecimal(unitValue),
        unaffectedAmount,
        payableAmount: unaffectedAmount,
      });
    }
    case 'FREE': {
      const referenceUnitValue = parseDecimal(line.referenceUnitValue, 'referenceUnitValue');
      const freeAmount = Money.of(quantity.times(referenceUnitValue), currency);
      const isTaxed = line.freeTaxTreatment === 'TAXED';
      const igvRate = isTaxed ? normalizedIgvRate(line.igvRate) : undefined;
      const freeIgvAmount = igvRate
        ? Money.of(freeAmount.toDecimal().times(igvRate), currency)
        : zero;

      return Object.freeze({
        ...baseCalculatedLine(line, quantity, currency),
        freeTaxTreatment: line.freeTaxTreatment,
        referenceUnitValue: canonicalDecimal(referenceUnitValue),
        ...(igvRate ? { igvRate: canonicalDecimal(igvRate) } : {}),
        freeAmount,
        freeIgvAmount,
      });
    }
  }
}

function baseCalculatedLine(
  line: FiscalLineInput,
  quantity: Decimal,
  currency: string,
): CalculatedFiscalLine {
  const zero = Money.zero(currency);
  return {
    lineId: line.lineId.trim(),
    description: line.description.trim(),
    quantity: canonicalDecimal(quantity),
    taxCategory: line.taxCategory,
    taxableAmount: zero,
    exoneratedAmount: zero,
    unaffectedAmount: zero,
    freeAmount: zero,
    igvAmount: zero,
    freeIgvAmount: zero,
    payableAmount: zero,
  };
}

function sumTotals(lines: readonly CalculatedFiscalLine[], currency: string): FiscalDocumentTotals {
  return Object.freeze(
    lines.reduce<FiscalDocumentTotals>(
      (totals, line) => ({
        taxableAmount: totals.taxableAmount.add(line.taxableAmount),
        exoneratedAmount: totals.exoneratedAmount.add(line.exoneratedAmount),
        unaffectedAmount: totals.unaffectedAmount.add(line.unaffectedAmount),
        freeAmount: totals.freeAmount.add(line.freeAmount),
        igvAmount: totals.igvAmount.add(line.igvAmount),
        freeIgvAmount: totals.freeIgvAmount.add(line.freeIgvAmount),
        payableAmount: totals.payableAmount.add(line.payableAmount),
      }),
      zeroTotals(currency),
    ),
  );
}

function zeroTotals(currency: string): FiscalDocumentTotals {
  return {
    taxableAmount: Money.zero(currency),
    exoneratedAmount: Money.zero(currency),
    unaffectedAmount: Money.zero(currency),
    freeAmount: Money.zero(currency),
    igvAmount: Money.zero(currency),
    freeIgvAmount: Money.zero(currency),
    payableAmount: Money.zero(currency),
  };
}

function normalizedIgvRate(value?: DecimalValue): Decimal {
  return new FiscalDecimal(value ?? DEFAULT_IGV_RATE);
}

function freezeNoteReference(reference: NoteReference): Readonly<NoteReference> {
  return Object.freeze({
    document: Object.freeze({
      documentType: reference.document.documentType,
      series: reference.document.series.trim(),
      number: reference.document.number.trim(),
    }),
    reasonCode: reference.reasonCode.trim(),
    reason: reference.reason.trim(),
  });
}

function tryParseDecimal(value: unknown): Decimal | undefined {
  try {
    return parseDecimal(value);
  } catch {
    return undefined;
  }
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function issue(code: FiscalValidationCode, path: string, message: string): FiscalValidationIssue {
  return Object.freeze({ code, path, message });
}
