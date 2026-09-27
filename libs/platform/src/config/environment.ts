import Joi from 'joi';

export interface BillingEnvironment {
  NODE_ENV: 'development' | 'test' | 'production';
  BILLING_SERVICE:
    | 'billing-api'
    | 'billing-worker'
    | 'sunat-service'
    | 'webhook-service'
    | 'migration-runner';
  BILLING_PUBLIC_URL: string;
  PORT: number;
  BILLING_WORKER_PORT: number;
  SUNAT_SERVICE_PORT: number;
  WEBHOOK_SERVICE_PORT: number;
  SUNAT_INTERNAL_URL: string;
  WEBHOOK_INTERNAL_URL: string;
  INTERNAL_SERVICE_TIMEOUT_MS: number;
  CORE_DATABASE_URL: string;
  SUNAT_DATABASE_URL: string;
  WEBHOOK_DATABASE_URL: string;
  CORE_DATABASE_PASSWORD_FILE?: string;
  SUNAT_DATABASE_PASSWORD_FILE?: string;
  WEBHOOK_DATABASE_PASSWORD_FILE?: string;
  BILLING_JWT_SECRET_FILE?: string;
  BILLING_JWT_ISSUER: string;
  BILLING_JWT_AUDIENCE: string;
  BILLING_API_KEY_PEPPER_FILE?: string;
  BILLING_API_KEY_REPLAY_KEY_FILE?: string;
  BILLING_API_KEY_REPLAY_TTL_SECONDS: number;
  BILLING_MASTER_KEY_FILE?: string;
  SUNAT_INTERNAL_SERVICE_SECRET_FILE?: string;
  WEBHOOK_INTERNAL_SERVICE_SECRET_FILE?: string;
  R2_ENDPOINT?: string;
  R2_REGION: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID_FILE?: string;
  R2_SECRET_ACCESS_KEY_FILE?: string;
  R2_SIGNED_URL_TTL_SECONDS: number;
  ALLOW_VOLATILE_ADAPTERS: boolean;
  SUNAT_PROVIDER_MODE: 'beta' | 'production';
  SUNAT_BETA_ISSUER_RUC?: string;
  SUNAT_BETA_KEY_FILE?: string;
  SUNAT_BETA_CERT_FILE?: string;
  BILLING_EMAIL_MODE: 'disabled' | 'mailpit' | 'smtp';
  BILLING_SMTP_HOST?: string;
  BILLING_SMTP_PORT: number;
  BILLING_SMTP_USER?: string;
  BILLING_SMTP_PASSWORD_FILE?: string;
  BILLING_EMAIL_FROM?: string;
  BILLING_MAILPIT_HOST: '127.0.0.1' | 'mailpit';
  BILLING_MAILPIT_PORT: number;
  SUNAT_ENVIRONMENT: 'beta' | 'production';
  SUNAT_BILL_SERVICE_URL?: string;
  SUNAT_CONSULT_SERVICE_URL?: string;
  SUNAT_TIMEOUT_MS: number;
  WEBHOOK_TIMEOUT_MS: number;
}

export const environmentSchema = Joi.object<BillingEnvironment>({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  BILLING_SERVICE: Joi.string()
    .valid('billing-api', 'billing-worker', 'sunat-service', 'webhook-service', 'migration-runner')
    .default('billing-api'),
  BILLING_PUBLIC_URL: Joi.string().uri().default('http://localhost:3000'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  BILLING_WORKER_PORT: Joi.number().integer().min(1).max(65535).default(3001),
  SUNAT_SERVICE_PORT: Joi.number().integer().min(1).max(65535).default(3002),
  WEBHOOK_SERVICE_PORT: Joi.number().integer().min(1).max(65535).default(3003),
  SUNAT_INTERNAL_URL: Joi.string().uri().default('http://localhost:3002'),
  WEBHOOK_INTERNAL_URL: Joi.string().uri().default('http://localhost:3003'),
  INTERNAL_SERVICE_TIMEOUT_MS: Joi.number().integer().min(500).max(30000).default(5000),
  CORE_DATABASE_URL: Joi.string()
    .min(1)
    .default('postgres://billing_core:billing_core@localhost:5432/billing_core'),
  SUNAT_DATABASE_URL: Joi.string()
    .min(1)
    .default('postgres://billing_sunat:billing_sunat@localhost:5432/billing_sunat'),
  WEBHOOK_DATABASE_URL: Joi.string()
    .min(1)
    .default('postgres://billing_delivery:billing_delivery@localhost:5432/billing_delivery'),
  CORE_DATABASE_PASSWORD_FILE: Joi.string().min(1).optional(),
  SUNAT_DATABASE_PASSWORD_FILE: Joi.string().min(1).optional(),
  WEBHOOK_DATABASE_PASSWORD_FILE: Joi.string().min(1).optional(),
  BILLING_JWT_SECRET_FILE: Joi.string().min(1).optional(),
  BILLING_JWT_ISSUER: Joi.string().min(1).default('billing-admin'),
  BILLING_JWT_AUDIENCE: Joi.string().min(1).default('billing-api'),
  BILLING_API_KEY_PEPPER_FILE: Joi.string().min(1).optional(),
  BILLING_API_KEY_REPLAY_KEY_FILE: Joi.string().min(1).optional(),
  BILLING_API_KEY_REPLAY_TTL_SECONDS: Joi.number().integer().min(30).max(3600).default(300),
  BILLING_MASTER_KEY_FILE: Joi.string().min(1).optional(),
  SUNAT_INTERNAL_SERVICE_SECRET_FILE: Joi.string().min(1).optional(),
  WEBHOOK_INTERNAL_SERVICE_SECRET_FILE: Joi.string().min(1).optional(),
  R2_ENDPOINT: Joi.string().uri().optional(),
  R2_REGION: Joi.string().min(1).default('auto'),
  R2_BUCKET: Joi.string().min(1).default('billing-private'),
  R2_ACCESS_KEY_ID_FILE: Joi.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY_FILE: Joi.string().min(1).optional(),
  R2_SIGNED_URL_TTL_SECONDS: Joi.number().integer().min(30).max(3600).default(300),
  ALLOW_VOLATILE_ADAPTERS: Joi.boolean().default(false),
  SUNAT_PROVIDER_MODE: Joi.string().valid('beta', 'production').default('beta'),
  SUNAT_BETA_ISSUER_RUC: Joi.string()
    .pattern(/^20\d{9}$/u)
    .optional(),
  SUNAT_BETA_KEY_FILE: Joi.string().allow('').optional(),
  SUNAT_BETA_CERT_FILE: Joi.string().allow('').optional(),
  BILLING_EMAIL_MODE: Joi.string().valid('disabled', 'mailpit', 'smtp').default('disabled'),
  BILLING_SMTP_HOST: Joi.string().min(1).optional(),
  BILLING_SMTP_PORT: Joi.number().integer().min(1).max(65535).default(465),
  BILLING_SMTP_USER: Joi.string().min(1).optional(),
  BILLING_SMTP_PASSWORD_FILE: Joi.string().min(1).optional(),
  BILLING_EMAIL_FROM: Joi.string().email().optional(),
  BILLING_MAILPIT_HOST: Joi.string().valid('127.0.0.1', 'mailpit').default('127.0.0.1'),
  BILLING_MAILPIT_PORT: Joi.number().integer().min(1).max(65535).default(51025),
  SUNAT_ENVIRONMENT: Joi.string().valid('beta', 'production').default('production'),
  SUNAT_BILL_SERVICE_URL: Joi.string().uri().optional(),
  SUNAT_CONSULT_SERVICE_URL: Joi.string().uri().optional(),
  SUNAT_TIMEOUT_MS: Joi.number().integer().min(1000).max(120000).default(30000),
  WEBHOOK_TIMEOUT_MS: Joi.number().integer().min(1000).max(60000).default(10000),
}).custom((environment: BillingEnvironment, helpers) => {
  const issues: { key: string; message: string }[] = [];
  if (environment.BILLING_EMAIL_MODE === 'smtp') {
    for (const key of [
      'BILLING_SMTP_HOST',
      'BILLING_SMTP_USER',
      'BILLING_SMTP_PASSWORD_FILE',
      'BILLING_EMAIL_FROM',
    ] as const) {
      if (!environment[key]) issues.push({ key, message: 'Required for Facture email delivery' });
    }
  }
  if (environment.NODE_ENV !== 'production') {
    if (issues.length) {
      return helpers.message({
        custom: issues.map(({ key, message }) => `${key}: ${message}`).join('; '),
      });
    }
    return environment;
  }
  if (environment.BILLING_EMAIL_MODE === 'mailpit') {
    issues.push({ key: 'BILLING_EMAIL_MODE', message: 'Mailpit is restricted to development' });
  }

  const secretsByService = {
    'billing-api': [
      'BILLING_JWT_SECRET_FILE',
      'BILLING_API_KEY_PEPPER_FILE',
      'BILLING_API_KEY_REPLAY_KEY_FILE',
      'SUNAT_INTERNAL_SERVICE_SECRET_FILE',
      'WEBHOOK_INTERNAL_SERVICE_SECRET_FILE',
      'CORE_DATABASE_PASSWORD_FILE',
      'R2_ACCESS_KEY_ID_FILE',
      'R2_SECRET_ACCESS_KEY_FILE',
    ],
    'billing-worker': [
      'CORE_DATABASE_PASSWORD_FILE',
      'R2_ACCESS_KEY_ID_FILE',
      'R2_SECRET_ACCESS_KEY_FILE',
    ],
    'sunat-service': [
      'BILLING_MASTER_KEY_FILE',
      'SUNAT_INTERNAL_SERVICE_SECRET_FILE',
      'SUNAT_DATABASE_PASSWORD_FILE',
      'R2_ACCESS_KEY_ID_FILE',
      'R2_SECRET_ACCESS_KEY_FILE',
    ],
    'webhook-service': [
      'BILLING_MASTER_KEY_FILE',
      'WEBHOOK_INTERNAL_SERVICE_SECRET_FILE',
      'WEBHOOK_DATABASE_PASSWORD_FILE',
    ],
    'migration-runner': [
      'CORE_DATABASE_PASSWORD_FILE',
      'SUNAT_DATABASE_PASSWORD_FILE',
      'WEBHOOK_DATABASE_PASSWORD_FILE',
    ],
  } as const;
  const requiredSecretPaths = secretsByService[environment.BILLING_SERVICE];

  for (const key of requiredSecretPaths) {
    if (!environment[key]) {
      issues.push({ key, message: `${key} is required in production` });
    }
  }

  const urlsByService = {
    'billing-api': [['CORE_DATABASE_URL', environment.CORE_DATABASE_URL]],
    'billing-worker': [['CORE_DATABASE_URL', environment.CORE_DATABASE_URL]],
    'sunat-service': [['SUNAT_DATABASE_URL', environment.SUNAT_DATABASE_URL]],
    'webhook-service': [['WEBHOOK_DATABASE_URL', environment.WEBHOOK_DATABASE_URL]],
    'migration-runner': [
      ['CORE_DATABASE_URL', environment.CORE_DATABASE_URL],
      ['SUNAT_DATABASE_URL', environment.SUNAT_DATABASE_URL],
      ['WEBHOOK_DATABASE_URL', environment.WEBHOOK_DATABASE_URL],
    ],
  } as const;
  for (const [key, configuredUrl] of urlsByService[environment.BILLING_SERVICE]) {
    if (new URL(configuredUrl).password) {
      issues.push({
        key,
        message: `${key} must not embed a password in production; use its *_PASSWORD_FILE`,
      });
    }
  }

  const needsObjectStorage = ['billing-api', 'billing-worker', 'sunat-service'].includes(
    environment.BILLING_SERVICE,
  );
  if (needsObjectStorage && !environment.R2_ENDPOINT) {
    issues.push({ key: 'R2_ENDPOINT', message: 'R2_ENDPOINT is required in production' });
  }
  if (environment.ALLOW_VOLATILE_ADAPTERS) {
    issues.push({
      key: 'ALLOW_VOLATILE_ADAPTERS',
      message: 'Volatile adapters are forbidden in production',
    });
  }
  if (issues.length) {
    return helpers.message({
      custom: issues.map(({ key, message }) => `${key}: ${message}`).join('; '),
    });
  }
  return environment;
});

export function parseEnvironment(values: NodeJS.ProcessEnv): BillingEnvironment {
  const result = environmentSchema.validate(values, { allowUnknown: true, abortEarly: false });
  if (result.error) {
    throw new Error(`Invalid billing configuration: ${result.error.message}`);
  }
  return result.value;
}
