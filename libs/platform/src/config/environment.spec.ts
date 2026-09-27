import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { environmentSchema, parseEnvironment } from './environment';

describe('billing environment', () => {
  it('provides a numeric PORT through ConfigModule validationSchema', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          validationSchema: environmentSchema,
        }),
      ],
    }).compile();
    try {
      expect(module.get(ConfigService).get('PORT')).toBe(3000);
    } finally {
      await module.close();
    }
  });

  it('converts the configured port and boolean values', () => {
    const environment = parseEnvironment({ PORT: '3300', ALLOW_VOLATILE_ADAPTERS: 'false' });
    expect(environment.PORT).toBe(3300);
    expect(environment.ALLOW_VOLATILE_ADAPTERS).toBe(false);
  });

  it.each(['0', '65536', 'abc', '3.5'])('rejects invalid PORT %p', (PORT) => {
    expect(() => parseEnvironment({ PORT })).toThrow('PORT');
  });

  it('requires SMTP settings in development too', () => {
    expect(() => parseEnvironment({ BILLING_EMAIL_MODE: 'smtp' })).toThrow('BILLING_SMTP_HOST');
  });

  it.each(['SUNAT_INTERNAL_SERVICE_SECRET_FILE', 'WEBHOOK_INTERNAL_SERVICE_SECRET_FILE'] as const)(
    'requires the destination-specific %s for the production API',
    (secretName) => {
      const environment = productionApiEnvironment();
      delete environment[secretName];

      expect(() => parseEnvironment(environment)).toThrow(secretName);
    },
  );

  it('requires a separate API-key replay encryption key for the production API', () => {
    const environment = productionApiEnvironment();
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
    BILLING_MASTER_KEY_FILE: '/run/secrets/master_key',
    WEBHOOK_INTERNAL_SERVICE_SECRET_FILE: '/run/secrets/webhook_internal_secret',
  };
}
