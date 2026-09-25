import { SunatUnsafeConfigurationError } from '../../domain/errors/sunat.error';
import type {
  IssuerCredentialHandle,
  SignedUblDocument,
  UnsignedUblDocument,
} from '../../domain/models/sunat-outcome';
import type { XmlSignerPort } from '../../domain/ports/xml-signer.port';

/**
 * Makes the lack of a cryptographic signature explicit. It is intentionally
 * unusable with beta or production credentials.
 */
export class MockOnlyXmlSignerAdapter implements XmlSignerPort {
  sign(
    document: UnsignedUblDocument,
    credentials: IssuerCredentialHandle,
  ): Promise<SignedUblDocument> {
    if (credentials.environment !== 'mock') {
      return Promise.reject(
        new SunatUnsafeConfigurationError(
          'El firmador mock no puede utilizarse con SUNAT beta o producción.',
        ),
      );
    }

    return Promise.resolve({
      ...document,
      signature: {
        state: 'mock_unsigned' as const,
        certificateFingerprint: null,
      },
    });
  }

  readiness(): { ready: true; mode: 'mock_unsigned'; detail: string } {
    return {
      ready: true,
      mode: 'mock_unsigned',
      detail: 'Sólo apto para pruebas; no produce una firma XML válida.',
    };
  }
}
