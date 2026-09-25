export type SunatErrorCategory =
  | 'authentication'
  | 'configuration'
  | 'data_integrity'
  | 'provider_rejection'
  | 'provider_transient'
  | 'submission_ambiguous'
  | 'validation'
  | 'internal';

export interface SunatErrorOptions {
  category: SunatErrorCategory;
  code: string;
  message: string;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * A boundary-safe error. Its message is deliberately suitable for logs and
 * events; provider bodies and credential material must stay in the adapter.
 */
export class SunatError extends Error {
  readonly category: SunatErrorCategory;
  readonly code: string;
  readonly retryable: boolean;

  constructor(options: SunatErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = SunatError.name;
    this.category = options.category;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SunatValidationError extends SunatError {
  constructor(code: string, message: string) {
    super({ category: 'validation', code, message });
    this.name = SunatValidationError.name;
  }
}

export class SunatPayloadIntegrityError extends SunatError {
  constructor(message = 'El payload fiscal no coincide con su huella SHA-256.') {
    super({
      category: 'data_integrity',
      code: 'SUNAT_PAYLOAD_INTEGRITY_FAILED',
      message,
    });
    this.name = SunatPayloadIntegrityError.name;
  }
}

export class SunatCredentialUnavailableError extends SunatError {
  constructor(message = 'No hay credenciales SUNAT utilizables para el emisor.') {
    super({
      category: 'configuration',
      code: 'SUNAT_CREDENTIAL_UNAVAILABLE',
      message,
    });
    this.name = SunatCredentialUnavailableError.name;
  }
}

export class SunatProviderTransientError extends SunatError {
  constructor(
    code = 'SUNAT_PROVIDER_UNAVAILABLE',
    message = 'SUNAT no está disponible temporalmente.',
  ) {
    super({
      category: 'provider_transient',
      code,
      message,
      retryable: true,
    });
    this.name = SunatProviderTransientError.name;
  }
}

export class SunatSubmissionAmbiguousError extends SunatError {
  readonly trackingId: string | null;

  constructor(trackingId?: string | null) {
    super({
      category: 'submission_ambiguous',
      code: 'SUNAT_SUBMISSION_AMBIGUOUS',
      message:
        'No se pudo confirmar la respuesta del envío; se requiere conciliación antes de cualquier reintento.',
    });
    this.name = SunatSubmissionAmbiguousError.name;
    this.trackingId = normalizeOptionalText(trackingId);
  }
}

export class SunatUnsafeConfigurationError extends SunatError {
  constructor(message: string) {
    super({
      category: 'configuration',
      code: 'SUNAT_UNSAFE_CONFIGURATION',
      message,
    });
    this.name = SunatUnsafeConfigurationError.name;
  }
}

export function toSafeSunatError(error: unknown): SunatError {
  if (error instanceof SunatError) {
    return error;
  }

  return new SunatError({
    category: 'internal',
    code: 'SUNAT_INTERNAL_ERROR',
    message: 'No se pudo completar la operación fiscal.',
    cause: error,
  });
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}
