import { fiscalDocumentFixture } from '../../testing/sunat-test-fixtures';
import { DeterministicUblBuilder } from '../ubl/deterministic-ubl-builder';
import { MockOnlyXmlSignerAdapter } from './mock-only-xml-signer.adapter';

describe('MockOnlyXmlSignerAdapter', () => {
  it('marks XML as mock-unsigned and refuses non-mock credentials', async () => {
    const signer = new MockOnlyXmlSignerAdapter();
    const document = new DeterministicUblBuilder().build(fiscalDocumentFixture());
    const mock = await signer.sign(document, {
      issuerId: 'issuer-1',
      credentialVersion: 1,
      environment: 'mock',
      certificateReference: null,
      certificateFingerprint: null,
      solCredentialReference: null,
    });

    expect(mock.signature.state).toBe('mock_unsigned');
    await expect(
      signer.sign(document, {
        issuerId: 'issuer-1',
        credentialVersion: 1,
        environment: 'production',
        certificateReference: 'secret://certificate',
        certificateFingerprint: 'fingerprint',
        solCredentialReference: 'secret://sol',
      }),
    ).rejects.toThrow('no puede utilizarse con SUNAT beta o producción');
  });
});
