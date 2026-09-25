import { UnverifiedPkcs12XmlSignerAdapter } from './unverified-pkcs12-xml-signer.adapter';

describe('UnverifiedPkcs12XmlSignerAdapter', () => {
  it('never claims production capability without a verified XMLDSig fixture', async () => {
    const signer = new UnverifiedPkcs12XmlSignerAdapter();

    expect(signer.readiness()).toEqual(
      expect.objectContaining({ ready: false, mode: 'unavailable' }),
    );
    await expect(signer.sign()).rejects.toMatchObject({
      code: 'SUNAT_UNSAFE_CONFIGURATION',
    });
  });
});
