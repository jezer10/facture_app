import { fiscalDocumentFixture } from '../../testing/sunat-test-fixtures';
import { toFiscalDocumentIdentity } from '../../domain/models/fiscal-document';
import type { SignedUblDocument } from '../../domain/models/sunat-outcome';
import {
  DirectSunatProviderAdapter,
  OFFICIAL_SUNAT_ENDPOINTS,
} from './direct-sunat-provider.adapter';

describe('DirectSunatProviderAdapter', () => {
  it('accepts only official HTTPS endpoints and remains explicitly unavailable', async () => {
    const provider = productionProvider();

    await expect(provider.health()).resolves.toEqual(
      expect.objectContaining({ ready: false, environment: 'production' }),
    );
    expect(
      () =>
        new DirectSunatProviderAdapter({
          ...provider.options,
          billServiceUrl: 'https://example.com/billService',
        }),
    ).toThrow('host oficial');
  });

  it('fails closed even for a signed document until official SOAP/CDR fixtures pass', async () => {
    const identity = toFiscalDocumentIdentity(fiscalDocumentFixture());
    const document: SignedUblDocument = {
      identity,
      xml: '<Invoice/>',
      sha256: 'a'.repeat(64),
      signature: {
        state: 'signed',
        certificateFingerprint: 'b'.repeat(64),
      },
    };

    await expect(
      productionProvider().submitDocument(document, {
        issuerId: 'issuer-1',
        credentialVersion: 1,
        environment: 'production',
        certificateReference: 'opaque',
        certificateFingerprint: null,
        solCredentialReference: 'opaque',
      }),
    ).rejects.toMatchObject({ code: 'SUNAT_UNSAFE_CONFIGURATION' });
  });
});

function productionProvider(): DirectSunatProviderAdapter {
  return new DirectSunatProviderAdapter({
    environment: 'production',
    billServiceUrl: OFFICIAL_SUNAT_ENDPOINTS.productionBillService,
    consultServiceUrl: OFFICIAL_SUNAT_ENDPOINTS.productionConsultService,
    timeoutMs: 30_000,
  });
}
