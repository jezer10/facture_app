import type { CredentialCategory, LegacyCompanyRow } from './models';

export interface CredentialInventory {
  readonly accessTokensDiscarded: number;
  readonly categories: Readonly<Record<CredentialCategory, number>>;
}

export function classifyCredential(value: unknown): CredentialCategory {
  if (typeof value !== 'string' || value.length === 0) {
    return 'corrupt';
  }
  if (isLegacyAesGcmEnvelope(value) || isJsonEnvelope(value)) {
    return 'envelope';
  }
  if (value.includes(':') || value.trimStart().startsWith('{')) {
    return 'corrupt';
  }
  return 'plaintext';
}

export function inventoryCredentials(companies: readonly LegacyCompanyRow[]): CredentialInventory {
  const categories: Record<CredentialCategory, number> = {
    corrupt: 0,
    envelope: 0,
    plaintext: 0,
  };
  let accessTokensDiscarded = 0;

  for (const company of companies) {
    categories[classifyCredential(company.companyPassword)] += 1;
    categories[classifyCredential(company.clientSecret)] += 1;
    if (typeof company.accessToken === 'string' && company.accessToken.length > 0) {
      accessTokensDiscarded += 1;
    }
  }

  return { accessTokensDiscarded, categories: Object.freeze(categories) };
}

function isLegacyAesGcmEnvelope(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) {
    return false;
  }
  const [iv, tag, ciphertext] = parts;
  return (
    isBase64WithBytes(iv, 12) &&
    isBase64WithBytes(tag, 16) &&
    isBase64WithBytes(ciphertext, undefined, 1)
  );
}

function isJsonEnvelope(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.algorithm !== 'AES-256-GCM') {
    return false;
  }
  return (
    isBase64WithBytes(parsed.encryptedDataKey, undefined, 1) &&
    isBase64WithBytes(parsed.dataKeyIv, 12) &&
    isBase64WithBytes(parsed.dataKeyTag, 16) &&
    isBase64WithBytes(parsed.ciphertext, undefined, 1) &&
    isBase64WithBytes(parsed.dataIv, 12) &&
    isBase64WithBytes(parsed.dataTag, 16)
  );
}

function isBase64WithBytes(value: unknown, exactBytes?: number, minimumBytes = 0): boolean {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    return false;
  }
  return exactBytes === undefined ? bytes.length >= minimumBytes : bytes.length === exactBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
