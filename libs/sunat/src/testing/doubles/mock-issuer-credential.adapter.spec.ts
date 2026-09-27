import { MockIssuerCredentialAdapter } from './mock-issuer-credential.adapter';

describe('MockIssuerCredentialAdapter', () => {
  it('denies unknown issuers unless the development opt-in is explicit', async () => {
    await expect(new MockIssuerCredentialAdapter().resolve('issuer-dynamic')).rejects.toMatchObject(
      { code: 'SUNAT_CREDENTIAL_UNAVAILABLE' },
    );

    await expect(
      new MockIssuerCredentialAdapter([], true).resolve('issuer-dynamic'),
    ).resolves.toEqual(
      expect.objectContaining({ issuerId: 'issuer-dynamic', environment: 'mock' }),
    );
  });
});
