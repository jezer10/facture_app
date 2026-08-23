import { parseEnvironment } from './environment';

describe('billing environment', () => {
  it('accepts an explicit list of trusted proxy CIDRs', () => {
    const environment = parseEnvironment({
      NODE_ENV: 'development',
      BILLING_TRUSTED_PROXY_CIDRS: '172.18.0.1/32, 2001:db8::1/128',
    });

    expect(environment.BILLING_TRUSTED_PROXY_CIDRS).toBe('172.18.0.1/32, 2001:db8::1/128');
  });

  it.each(['', 'loopback', '127.0.0.1', '0.0.0.0/0', '::/0', '10.0.0.1/33'])(
    'rejects unsafe or malformed trusted proxy value %p',
    (value) => {
      expect(() =>
        parseEnvironment({ NODE_ENV: 'development', BILLING_TRUSTED_PROXY_CIDRS: value }),
      ).toThrow('BILLING_TRUSTED_PROXY_CIDRS');
    },
  );

  it('requires trusted proxy CIDRs for the production API', () => {
    expect(() => parseEnvironment(productionApiEnvironment())).toThrow(
      'BILLING_TRUSTED_PROXY_CIDRS',
    );
  });

  it.each(['SUNAT_INTERNAL_SERVICE_SECRET_FILE', 'WEBHOOK_INTERNAL_SERVICE_SECRET_FILE'] as const)(
    'requires the destination-specific %s for the production API',
    (secretName) => {
      const environment = productionApiEnvironment();
      environment.BILLING_TRUSTED_PROXY_CIDRS = '172.30.250.1/32';
      delete environment[secretName];

      expect(() => parseEnvironment(environment)).toThrow(secretName);
    },
  );

  it('requires a separate API-key replay encryption key for the production API', () => {
    const environment = productionApiEnvironment();
    environment.BILLING_TRUSTED_PROXY_CIDRS = '172.30.250.1/32';
    delete environment.BILLING_API_KEY_REPLAY_KEY_FILE;

    expect(() => parseEnvironment(environment)).toThrow('BILLING_API_KEY_REPLAY_KEY_FILE');
  });

  it('requires only the SUNAT bearer in the production SUNAT service', () => {
    const environment = productionSunatEnvironment();

    expect(parseEnvironment(environment).WEBHOOK_INTERNAL_SERVICE_SECRET_FILE).toBeUndefined();
    delete environment.SUNAT_INTERNAL_SERVICE_SECRET_FILE;
    expect(() => parseEnvironment(environment)).toThrow('SUNAT_INTERNAL_SERVICE_SECRET_FILE');
  });

  it('requires only the webhook bearer in the production webhook service', () => {
    const environment = productionWebhookEnvironment();

    expect(parseEnvironment(environment).SUNAT_INTERNAL_SERVICE_SECRET_FILE).toBeUndefined();
    delete environment.WEBHOOK_INTERNAL_SERVICE_SECRET_FILE;
    expect(() => parseEnvironment(environment)).toThrow('WEBHOOK_INTERNAL_SERVICE_SECRET_FILE');
  });
});

function productionApiEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    BILLING_SERVICE: 'billing-api',
    BILLING_PUBLIC_URL: 'https://billing.example.com',
    CORE_DATABASE_URL: 'postgresql://billing_core@postgres:5432/billing_core',
    CORE_DATABASE_PASSWORD_FILE: '/run/secrets/core_db_password',
    BILLING_JWT_SECRET_FILE: '/run/secrets/jwt_secret',
    BILLING_API_KEY_PEPPER_FILE: '/run/secrets/api_key_pepper',
    BILLING_API_KEY_REPLAY_KEY_FILE: '/run/secrets/api_key_replay_key',
    SUNAT_INTERNAL_SERVICE_SECRET_FILE: '/run/secrets/sunat_internal_secret',
    WEBHOOK_INTERNAL_SERVICE_SECRET_FILE: '/run/secrets/webhook_internal_secret',
    R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID_FILE: '/run/secrets/r2_access_key_id',
    R2_SECRET_ACCESS_KEY_FILE: '/run/secrets/r2_secret_access_key',
  };
}

function productionSunatEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    BILLING_SERVICE: 'sunat-service',
    BILLING_PUBLIC_URL: 'https://billing.example.com',
    SUNAT_DATABASE_URL: 'postgresql://billing_sunat@postgres:5432/billing_sunat',
    SUNAT_DATABASE_PASSWORD_FILE: '/run/secrets/sunat_db_password',
    REDIS_URL: 'redis://billing_sunat@redis:6379/0',
    REDIS_PASSWORD_FILE: '/run/secrets/redis_password',
    BILLING_MASTER_KEY_FILE: '/run/secrets/master_key',
    SUNAT_INTERNAL_SERVICE_SECRET_FILE: '/run/secrets/sunat_internal_secret',
    R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID_FILE: '/run/secrets/r2_access_key_id',
    R2_SECRET_ACCESS_KEY_FILE: '/run/secrets/r2_secret_access_key',
    SUNAT_PROVIDER_MODE: 'production',
  };
}

function productionWebhookEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    BILLING_SERVICE: 'webhook-service',
    BILLING_PUBLIC_URL: 'https://billing.example.com',
    WEBHOOK_DATABASE_URL: 'postgresql://billing_delivery@postgres:5432/billing_delivery',
    WEBHOOK_DATABASE_PASSWORD_FILE: '/run/secrets/webhook_db_password',
    REDIS_URL: 'redis://billing_webhook@redis:6379/0',
    REDIS_PASSWORD_FILE: '/run/secrets/redis_password',
    BILLING_MASTER_KEY_FILE: '/run/secrets/master_key',
    WEBHOOK_INTERNAL_SERVICE_SECRET_FILE: '/run/secrets/webhook_internal_secret',
  };
}
