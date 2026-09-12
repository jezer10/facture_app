import type { PublicDocumentStatus } from '@app/contracts';

export type FiscalDocumentsErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_RESOURCE_MISSING'
  | 'ISSUER_ACCESS_DENIED'
  | 'ISSUER_UNAVAILABLE'
  | 'SERIES_UNAVAILABLE'
  | 'DOCUMENT_NOT_FOUND'
  | 'INVALID_REFERENCE_DOCUMENT'
  | 'INVALID_DOCUMENT_STATE'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_LIST_QUERY'
  | 'INVALID_VOID_REASON'
  | 'INVALID_LINE_DISCOUNT'
  | 'INVALID_FREE_LINE'
  | 'INVALID_TAX_RATE'
  | 'CORRELATIVE_EXHAUSTED';

export class FiscalDocumentsError extends Error {
  constructor(
    public readonly code: FiscalDocumentsErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FiscalDocumentsError';
  }
}

export class IdempotencyConflictError extends FiscalDocumentsError {
  constructor(public readonly idempotencyKey: string) {
    super(
      'IDEMPOTENCY_CONFLICT',
      `Idempotency key ${idempotencyKey} was already used with a different request`,
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyResourceMissingError extends FiscalDocumentsError {
  constructor(public readonly resourceId: string) {
    super(
      'IDEMPOTENCY_RESOURCE_MISSING',
      `Idempotency record points to missing fiscal document ${resourceId}`,
    );
    this.name = 'IdempotencyResourceMissingError';
  }
}

export class IssuerAccessDeniedError extends FiscalDocumentsError {
  constructor(public readonly issuerId: string) {
    super('ISSUER_ACCESS_DENIED', 'The principal cannot use the requested issuer');
    this.name = 'IssuerAccessDeniedError';
  }
}

export class IssuerUnavailableError extends FiscalDocumentsError {
  constructor(public readonly issuerId: string) {
    super('ISSUER_UNAVAILABLE', `Issuer ${issuerId} is not active`);
    this.name = 'IssuerUnavailableError';
  }
}

export class FiscalSeriesUnavailableError extends FiscalDocumentsError {
  constructor(public readonly seriesId: string) {
    super(
      'SERIES_UNAVAILABLE',
      `The requested fiscal series ${seriesId} is missing, inactive or incompatible`,
    );
    this.name = 'FiscalSeriesUnavailableError';
  }
}

export class FiscalDocumentNotFoundError extends FiscalDocumentsError {
  constructor(public readonly documentId: string) {
    super('DOCUMENT_NOT_FOUND', `Fiscal document ${documentId} was not found`);
    this.name = 'FiscalDocumentNotFoundError';
  }
}

export class InvalidReferenceDocumentError extends FiscalDocumentsError {
  constructor(message: string) {
    super('INVALID_REFERENCE_DOCUMENT', message);
    this.name = 'InvalidReferenceDocumentError';
  }
}

export class InvalidFiscalDocumentStateError extends FiscalDocumentsError {
  constructor(
    public readonly documentId: string,
    public readonly status: PublicDocumentStatus,
  ) {
    super(
      'INVALID_DOCUMENT_STATE',
      `Fiscal document ${documentId} cannot be voided from status ${status}`,
    );
    this.name = 'InvalidFiscalDocumentStateError';
  }
}

export class InvalidFiscalRequestError extends FiscalDocumentsError {
  constructor(
    code:
      | 'INVALID_IDEMPOTENCY_KEY'
      | 'INVALID_LIST_QUERY'
      | 'INVALID_VOID_REASON'
      | 'INVALID_LINE_DISCOUNT'
      | 'INVALID_FREE_LINE'
      | 'INVALID_TAX_RATE',
    message: string,
  ) {
    super(code, message);
    this.name = 'InvalidFiscalRequestError';
  }
}

export class CorrelativeExhaustedError extends FiscalDocumentsError {
  constructor(public readonly seriesId: string) {
    super(
      'CORRELATIVE_EXHAUSTED',
      `Fiscal series ${seriesId} has an invalid or exhausted next number`,
    );
    this.name = 'CorrelativeExhaustedError';
  }
}
