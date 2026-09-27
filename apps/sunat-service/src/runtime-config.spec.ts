import { resultAttempts, resultBackoffMs, sunatProviderMode } from './runtime-config';

describe('sunat-service runtime configuration', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = { ...originalEnvironment };
    delete process.env.NODE_ENV;
    delete process.env.SUNAT_PROVIDER_MODE;
    delete process.env.SUNAT_MOCK_ALLOW_ANY_ISSUER;
    delete process.env.SUNAT_RESULT_ATTEMPTS;
    delete process.env.SUNAT_RESULT_BACKOFF_MS;
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('defaults to SUNAT beta and rejects the removed simulated mode', () => {
    expect(sunatProviderMode()).toBe('beta');
    process.env.SUNAT_PROVIDER_MODE = 'mock';
    expect(() => sunatProviderMode()).toThrow('SUNAT_PROVIDER_MODE');
  });

  it('configures bounded result-job retry defaults and validates overrides', () => {
    expect(resultAttempts()).toBe(8);
    expect(resultBackoffMs()).toBe(1_000);

    process.env.SUNAT_RESULT_ATTEMPTS = '12';
    process.env.SUNAT_RESULT_BACKOFF_MS = '2500';
    expect(resultAttempts()).toBe(12);
    expect(resultBackoffMs()).toBe(2_500);

    process.env.SUNAT_RESULT_ATTEMPTS = '0';
    expect(() => resultAttempts()).toThrow('SUNAT_RESULT_ATTEMPTS');
  });
});
