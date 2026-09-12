import { parseEnvironment, redisOptionsFromUrl, type BillingEnvironment } from '@app/platform';
import type { ConnectionOptions } from 'bullmq';

export function sunatMockIssuerIds(): string[] {
  return (process.env.SUNAT_MOCK_ISSUER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function sunatMockAllowAnyIssuer(): boolean {
  const value = process.env.SUNAT_MOCK_ALLOW_ANY_ISSUER?.trim().toLowerCase();
  if (value === undefined || value === 'false') {
    return false;
  }
  if (value !== 'true') {
    throw new Error('SUNAT_MOCK_ALLOW_ANY_ISSUER debe ser true o false.');
  }
  if (environment().NODE_ENV === 'production') {
    throw new Error('SUNAT_MOCK_ALLOW_ANY_ISSUER está prohibido en producción.');
  }
  return true;
}

export function sunatProviderMode(): 'mock' | 'production' {
  return environment().SUNAT_PROVIDER_MODE;
}

export function redisConnectionConfig(): ConnectionOptions {
  const configured = environment();
  return {
    ...redisOptionsFromUrl(configured.REDIS_URL, configured.REDIS_PASSWORD_FILE),
    enableOfflineQueue: false,
  };
}

export function commandAttempts(): number {
  return positiveInteger(process.env.SUNAT_COMMAND_ATTEMPTS, 4, 'SUNAT_COMMAND_ATTEMPTS');
}

export function commandBackoffMs(): number {
  return positiveInteger(process.env.SUNAT_COMMAND_BACKOFF_MS, 5_000, 'SUNAT_COMMAND_BACKOFF_MS');
}

export function resultAttempts(): number {
  return positiveInteger(process.env.SUNAT_RESULT_ATTEMPTS, 8, 'SUNAT_RESULT_ATTEMPTS');
}

export function resultBackoffMs(): number {
  return positiveInteger(process.env.SUNAT_RESULT_BACKOFF_MS, 1_000, 'SUNAT_RESULT_BACKOFF_MS');
}

export function reconciliationDelayMs(): number {
  return positiveInteger(
    process.env.SUNAT_RECONCILIATION_DELAY_MS,
    30_000,
    'SUNAT_RECONCILIATION_DELAY_MS',
  );
}

export function reconciliationAttempts(): number {
  return positiveInteger(
    process.env.SUNAT_RECONCILIATION_ATTEMPTS,
    6,
    'SUNAT_RECONCILIATION_ATTEMPTS',
  );
}

export function servicePort(): number {
  return positiveInteger(process.env.SUNAT_SERVICE_PORT, 3_002, 'SUNAT_SERVICE_PORT');
}

export function serviceHost(): string {
  return normalizedOptional(process.env.SUNAT_SERVICE_HOST) ?? '127.0.0.1';
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} debe ser un entero positivo.`);
  }
  return parsed;
}

function normalizedOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function environment(): BillingEnvironment {
  return parseEnvironment({
    ...process.env,
    BILLING_SERVICE: 'sunat-service',
  });
}
