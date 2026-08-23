import { isIP } from 'node:net';
import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const trustedProxyCidrs = z
  .string()
  .trim()
  .superRefine((value, context) => {
    const entries = value.split(',').map((entry) => entry.trim());
    if (entries.some((entry) => !isRestrictedCidr(entry))) {
      context.addIssue({
        code: 'custom',
        message:
          'BILLING_TRUSTED_PROXY_CIDRS must contain valid comma-separated CIDRs and must not trust a /0 network',
      });
    }
  })
  .optional();

function isRestrictedCidr(value: string): boolean {
  const separator = value.lastIndexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    return false;
  }

  const address = value.slice(0, separator);
  const prefixText = value.slice(separator + 1);
  const family = isIP(address);
  if (family === 0 || !/^\d{1,3}$/u.test(prefixText)) {
    return false;
  }

  const prefix = Number(prefixText);
  const maximumPrefix = family === 4 ? 32 : 128;
  return prefix > 0 && prefix <= maximumPrefix;
}

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    BILLING_SERVICE: z
      .enum([
        'billing-api',
        'billing-worker',
        'sunat-service',
        'webhook-service',
        'migration-runner',
      ])
      .default('billing-api'),
    BILLING_PUBLIC_URL: z.url().default('http://localhost:3000'),
    BILLING_TRUSTED_PROXY_CIDRS: trustedProxyCidrs,
    BILLING_API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    BILLING_WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    SUNAT_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    WEBHOOK_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
    SUNAT_INTERNAL_URL: z.url().default('http://localhost:3002'),
    WEBHOOK_INTERNAL_URL: z.url().default('http://localhost:3003'),
    INTERNAL_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
    CORE_DATABASE_URL: z
      .string()
      .min(1)
      .default('postgres://billing_core:billing_core@localhost:5432/billing_core'),
    SUNAT_DATABASE_URL: z
      .string()
      .min(1)
      .default('postgres://billing_sunat:billing_sunat@localhost:5432/billing_sunat'),
    WEBHOOK_DATABASE_URL: z
      .string()
      .min(1)
      .default('postgres://billing_delivery:billing_delivery@localhost:5432/billing_delivery'),
    CORE_DATABASE_PASSWORD_FILE: z.string().min(1).optional(),
    SUNAT_DATABASE_PASSWORD_FILE: z.string().min(1).optional(),
    WEBHOOK_DATABASE_PASSWORD_FILE: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379/0'),
    REDIS_PASSWORD_FILE: z.string().min(1).optional(),
    BILLING_JWT_SECRET_FILE: z.string().min(1).optional(),
    BILLING_JWT_ISSUER: z.string().min(1).default('billing-admin'),
    BILLING_JWT_AUDIENCE: z.string().min(1).default('billing-api'),
    BILLING_API_KEY_PEPPER_FILE: z.string().min(1).optional(),
    BILLING_API_KEY_REPLAY_KEY_FILE: z.string().min(1).optional(),
    BILLING_API_KEY_REPLAY_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    BILLING_MASTER_KEY_FILE: z.string().min(1).optional(),
    SUNAT_INTERNAL_SERVICE_SECRET_FILE: z.string().min(1).optional(),
    WEBHOOK_INTERNAL_SERVICE_SECRET_FILE: z.string().min(1).optional(),
    R2_ENDPOINT: z.url().optional(),
    R2_REGION: z.string().min(1).default('auto'),
    R2_BUCKET: z.string().min(1).default('billing-private'),
    R2_ACCESS_KEY_ID_FILE: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY_FILE: z.string().min(1).optional(),
    R2_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    ALLOW_VOLATILE_ADAPTERS: booleanFromString,
    SUNAT_PROVIDER_MODE: z.enum(['mock', 'production']).default('mock'),
    SUNAT_ENVIRONMENT: z.enum(['beta', 'production']).default('production'),
    SUNAT_BILL_SERVICE_URL: z.url().optional(),
    SUNAT_CONSULT_SERVICE_URL: z.url().optional(),
    SUNAT_MOCK_ISSUER_IDS: z.string().optional(),
    SUNAT_MOCK_ALLOW_ANY_ISSUER: booleanFromString,
    SUNAT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== 'production') {
      return;
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
        'REDIS_PASSWORD_FILE',
        'R2_ACCESS_KEY_ID_FILE',
        'R2_SECRET_ACCESS_KEY_FILE',
      ],
      'sunat-service': [
        'BILLING_MASTER_KEY_FILE',
        'SUNAT_INTERNAL_SERVICE_SECRET_FILE',
        'SUNAT_DATABASE_PASSWORD_FILE',
        'REDIS_PASSWORD_FILE',
        'R2_ACCESS_KEY_ID_FILE',
        'R2_SECRET_ACCESS_KEY_FILE',
      ],
      'webhook-service': [
        'BILLING_MASTER_KEY_FILE',
        'WEBHOOK_INTERNAL_SERVICE_SECRET_FILE',
        'WEBHOOK_DATABASE_PASSWORD_FILE',
        'REDIS_PASSWORD_FILE',
      ],
      'migration-runner': [
        'CORE_DATABASE_PASSWORD_FILE',
        'SUNAT_DATABASE_PASSWORD_FILE',
        'WEBHOOK_DATABASE_PASSWORD_FILE',
      ],
    } as const;
    const requiredSecretPaths = secretsByService[environment.BILLING_SERVICE];

    if (environment.BILLING_SERVICE === 'billing-api' && !environment.BILLING_TRUSTED_PROXY_CIDRS) {
      context.addIssue({
        code: 'custom',
        path: ['BILLING_TRUSTED_PROXY_CIDRS'],
        message: 'BILLING_TRUSTED_PROXY_CIDRS is required for billing-api in production',
      });
    }

    for (const key of requiredSecretPaths) {
      if (!environment[key]) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required in production`,
        });
      }
    }

    const urlsByService = {
      'billing-api': [['CORE_DATABASE_URL', environment.CORE_DATABASE_URL]],
      'billing-worker': [
        ['CORE_DATABASE_URL', environment.CORE_DATABASE_URL],
        ['REDIS_URL', environment.REDIS_URL],
      ],
      'sunat-service': [
        ['SUNAT_DATABASE_URL', environment.SUNAT_DATABASE_URL],
        ['REDIS_URL', environment.REDIS_URL],
      ],
      'webhook-service': [
        ['WEBHOOK_DATABASE_URL', environment.WEBHOOK_DATABASE_URL],
        ['REDIS_URL', environment.REDIS_URL],
      ],
      'migration-runner': [
        ['CORE_DATABASE_URL', environment.CORE_DATABASE_URL],
        ['SUNAT_DATABASE_URL', environment.SUNAT_DATABASE_URL],
        ['WEBHOOK_DATABASE_URL', environment.WEBHOOK_DATABASE_URL],
      ],
    } as const;
    for (const [key, configuredUrl] of urlsByService[environment.BILLING_SERVICE]) {
      if (new URL(configuredUrl).password) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must not embed a password in production; use its *_PASSWORD_FILE`,
        });
      }
    }

    const redisUserByService: Readonly<Partial<Record<string, string>>> = {
      'billing-worker': 'billing_worker',
      'sunat-service': 'billing_sunat',
      'webhook-service': 'billing_webhook',
    };
    const expectedRedisUser = redisUserByService[environment.BILLING_SERVICE];
    if (
      expectedRedisUser &&
      decodeURIComponent(new URL(environment.REDIS_URL).username) !== expectedRedisUser
    ) {
      context.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: `REDIS_URL must use the ${expectedRedisUser} ACL user in production`,
      });
    }

    const needsObjectStorage = ['billing-api', 'billing-worker', 'sunat-service'].includes(
      environment.BILLING_SERVICE,
    );
    if (needsObjectStorage && !environment.R2_ENDPOINT) {
      context.addIssue({
        code: 'custom',
        path: ['R2_ENDPOINT'],
        message: 'R2_ENDPOINT is required in production',
      });
    }
    if (
      environment.BILLING_SERVICE === 'sunat-service' &&
      environment.SUNAT_PROVIDER_MODE !== 'production'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SUNAT_PROVIDER_MODE'],
        message: 'The mock SUNAT provider is forbidden in production',
      });
    }
    if (environment.ALLOW_VOLATILE_ADAPTERS) {
      context.addIssue({
        code: 'custom',
        path: ['ALLOW_VOLATILE_ADAPTERS'],
        message: 'Volatile adapters are forbidden in production',
      });
    }
  });

export type BillingEnvironment = z.infer<typeof environmentSchema>;

export function parseEnvironment(values: NodeJS.ProcessEnv): BillingEnvironment {
  const parsed = environmentSchema.safeParse(values);
  if (parsed.success) {
    return parsed.data;
  }

  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid billing configuration: ${issues}`);
}
