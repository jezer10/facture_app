import { SunatUnsafeConfigurationError } from '../../domain/errors/sunat.error';
import type { SignedUblDocument } from '../../domain/models/sunat-outcome';
import type { XmlSignerPort } from '../../domain/ports/xml-signer.port';

/**
 * Fail-closed production placeholder. Node does not expose a verifiable XMLDSig
 * PKCS#12 implementation and this repository has no official signed fixture.
 */
export class UnverifiedPkcs12XmlSignerAdapter implements XmlSignerPort {
  sign(): Promise<SignedUblDocument> {
    return Promise.reject(
      new SunatUnsafeConfigurationError(
        'La firma XML PKCS#12 no está habilitada: falta validarla contra fixtures oficiales SUNAT.',
      ),
    );
  }

  readiness(): {
    ready: false;
    mode: 'unavailable';
    detail: string;
  } {
    return {
      ready: false,
      mode: 'unavailable',
      detail:
        'Firma XMLDSig/PKCS#12 bloqueada hasta contar con implementación y fixture oficial verificable.',
    };
  }
}
