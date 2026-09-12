import {
  SunatUnsafeConfigurationError,
  SunatValidationError,
} from '../../domain/errors/sunat.error';
import type {
  FiscalDocumentIdentity,
  ReceivedDocumentSyncRequest,
} from '../../domain/models/fiscal-document';
import type {
  IssuerCredentialHandle,
  ReceivedDocumentSyncOutcome,
  SignedUblDocument,
  SunatProviderEnvironment,
  SunatProviderHealth,
  SunatReconciliationOutcome,
  SunatSubmissionOutcome,
  SunatVoidOutcome,
} from '../../domain/models/sunat-outcome';
import type { SunatProviderPort } from '../../domain/ports/sunat-provider.port';

export const OFFICIAL_SUNAT_ENDPOINTS = Object.freeze({
  betaBillService: 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
  productionBillService: 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService',
  productionConsultService: 'https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService',
});

export interface DirectSunatProviderOptions {
  readonly environment: Extract<SunatProviderEnvironment, 'beta' | 'production'>;
  readonly billServiceUrl: string;
  readonly consultServiceUrl: string;
  readonly timeoutMs: number;
}

/**
 * Configures the official direct boundary but deliberately refuses fiscal
 * operations until ZIP/SOAP/CDR fixtures and XML signature verification exist.
 */
export class DirectSunatProviderAdapter implements SunatProviderPort {
  readonly options: DirectSunatProviderOptions;

  constructor(options: DirectSunatProviderOptions) {
    this.options = validateOptions(options);
  }

  submitDocument(
    document: SignedUblDocument,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatSubmissionOutcome> {
    this.assertCredentialEnvironment(credentials);
    if (document.signature.state !== 'signed') {
      return Promise.reject(
        new SunatUnsafeConfigurationError(
          'SUNAT directo requiere un XML firmado criptográficamente.',
        ),
      );
    }
    return Promise.reject(unverifiedTransportError('sendBill'));
  }

  submitVoidCommunication(
    _identity: FiscalDocumentIdentity,
    _reason: string,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatVoidOutcome> {
    this.assertCredentialEnvironment(credentials);
    return Promise.reject(unverifiedTransportError('sendSummary'));
  }

  reconcileDocument(
    _identity: FiscalDocumentIdentity,
    _providerTrackingId: string | null,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatReconciliationOutcome> {
    this.assertCredentialEnvironment(credentials);
    return Promise.reject(unverifiedTransportError('getStatus'));
  }

  listReceivedDocuments(
    _request: ReceivedDocumentSyncRequest,
    credentials: IssuerCredentialHandle,
  ): Promise<ReceivedDocumentSyncOutcome> {
    this.assertCredentialEnvironment(credentials);
    return Promise.reject(unverifiedTransportError('consultacpe'));
  }

  health(): Promise<SunatProviderHealth> {
    return Promise.resolve({
      ready: false,
      provider: 'sunat-direct',
      environment: this.options.environment,
      detail:
        'Endpoints configurados, pero sendBill/sendSummary/getStatus/CDR permanecen bloqueados sin fixtures oficiales verificados.',
    });
  }

  private assertCredentialEnvironment(credentials: IssuerCredentialHandle): void {
    if (credentials.environment !== this.options.environment) {
      throw new SunatValidationError(
        'SUNAT_CREDENTIAL_ENVIRONMENT_MISMATCH',
        'Las credenciales no pertenecen al ambiente SUNAT configurado.',
      );
    }
  }
}

function validateOptions(options: DirectSunatProviderOptions): DirectSunatProviderOptions {
  const billServiceUrl = validateSunatUrl(
    options.billServiceUrl,
    options.environment,
    'billServiceUrl',
  );
  const consultServiceUrl = validateSunatUrl(
    options.consultServiceUrl,
    options.environment,
    'consultServiceUrl',
  );
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > 120_000
  ) {
    throw new SunatValidationError(
      'SUNAT_INVALID_TIMEOUT',
      'El timeout SUNAT debe estar entre 1000 y 120000 ms.',
    );
  }
  return { ...options, billServiceUrl, consultServiceUrl };
}

function validateSunatUrl(
  value: string,
  environment: DirectSunatProviderOptions['environment'],
  field: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidEndpoint(field);
  }
  const expectedHost =
    environment === 'production' ? 'e-factura.sunat.gob.pe' : 'e-beta.sunat.gob.pe';
  if (
    url.protocol !== 'https:' ||
    url.hostname !== expectedHost ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidEndpoint(field);
  }
  return url.toString().replace(/\/$/u, '');
}

function invalidEndpoint(field: string): SunatValidationError {
  return new SunatValidationError(
    'SUNAT_INVALID_ENDPOINT',
    `${field} debe usar HTTPS y el host oficial del ambiente SUNAT.`,
  );
}

function unverifiedTransportError(operation: string): SunatUnsafeConfigurationError {
  return new SunatUnsafeConfigurationError(
    `La operación ${operation} está bloqueada hasta validar SOAP, ZIP y CDR con fixtures oficiales SUNAT.`,
  );
}
