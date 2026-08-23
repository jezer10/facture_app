import {
  redisConnectionConfig,
  resultAttempts,
  resultBackoffMs,
  sunatMockAllowAnyIssuer,
  sunatProviderMode,
} from './runtime-config';

describe('sunat-service runtime configuration', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = { ...originalEnvironment };
    delete process.env.NODE_ENV;
    delete process.env.SUNAT_PROVIDER_MODE;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_PASSWORD_FILE;
    delete process.env.SUNAT_MOCK_ALLOW_ANY_ISSUER;
    delete process.env.SUNAT_RESULT_ATTEMPTS;
    delete process.env.SUNAT_RESULT_BACKOFF_MS;
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('defaults to an isolated local Redis connection and mock provider', () => {
    expect(sunatProviderMode()).toBe('mock');
    expect(redisConnectionConfig()).toEqual(
      expect.objectContaining({
        host: 'localhost',
        port: 6379,
        enableOfflineQueue: false,
      }),
    );
  });

  it('refuses mock mode in production and accepts fail-closed production mode', () => {
    process.env.NODE_ENV = 'production';
    expect(() => sunatProviderMode()).toThrow('SUNAT_PROVIDER_MODE');

    process.env.NODE_ENV = 'development';
    process.env.SUNAT_PROVIDER_MODE = 'production';
    expect(sunatProviderMode()).toBe('production');
  });

  it('loads Redis credentials from a secret file through platform configuration', () => {
    process.env.REDIS_URL = 'rediss://billing@redis.example:6380/2';
    process.env.REDIS_PASSWORD_FILE = '/tmp/not-used-in-unit-test';

    expect(() => redisConnectionConfig()).toThrow('/tmp/not-used-in-unit-test');
  });

  it('requires an explicit boolean opt-in for dynamic mock issuers', () => {
    expect(sunatMockAllowAnyIssuer()).toBe(false);
    process.env.SUNAT_MOCK_ALLOW_ANY_ISSUER = 'true';
    expect(sunatMockAllowAnyIssuer()).toBe(true);
    process.env.SUNAT_MOCK_ALLOW_ANY_ISSUER = 'yes';
    expect(() => sunatMockAllowAnyIssuer()).toThrow('true o false');
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
