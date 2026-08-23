import { readFile } from 'node:fs/promises';

import type { TenantMapping } from '../models';
import { LegacyMigrationError } from '../models';
import type { TenantMappingPort } from '../ports';

export class JsonTenantMappingAdapter implements TenantMappingPort {
  private constructor(
    private readonly companies: ReadonlyMap<string, TenantMapping>,
    private readonly recipientRucs: ReadonlyMap<string, TenantMapping>,
  ) {}

  static async fromFile(path: string): Promise<JsonTenantMappingAdapter> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw new LegacyMigrationError(
        'INVALID_MAPPING_FILE',
        'Tenant mapping file is missing or invalid JSON',
        { cause: error },
      );
    }
    if (!isRecord(parsed)) {
      throw new LegacyMigrationError('INVALID_MAPPING_FILE', 'Tenant mapping must be an object');
    }

    return new JsonTenantMappingAdapter(
      parseMappingSection(parsed.legacyCompanies, 'legacyCompanies'),
      parseMappingSection(parsed.recipientRucs, 'recipientRucs'),
    );
  }

  resolveLegacyCompany(legacyCompanyId: string, recipientRuc: string): TenantMapping | undefined {
    const mapping = this.companies.get(legacyCompanyId);
    return mapping?.recipientRuc === recipientRuc ? mapping : undefined;
  }

  resolveRecipientRuc(recipientRuc: string): TenantMapping | undefined {
    const mapping = this.recipientRucs.get(recipientRuc);
    return mapping?.recipientRuc === recipientRuc ? mapping : undefined;
  }
}

function parseMappingSection(value: unknown, section: string): ReadonlyMap<string, TenantMapping> {
  if (value === undefined) {
    return new Map();
  }
  if (!isRecord(value)) {
    throw new LegacyMigrationError(
      'INVALID_MAPPING_FILE',
      `Tenant mapping section ${section} must be an object`,
    );
  }

  const mappings = new Map<string, TenantMapping>();
  for (const [key, candidate] of Object.entries(value)) {
    if (!isMapping(candidate)) {
      throw new LegacyMigrationError(
        'INVALID_MAPPING_FILE',
        `Tenant mapping section ${section} contains an invalid entry`,
      );
    }
    mappings.set(key, Object.freeze({ ...candidate }));
  }
  return mappings;
}

function isMapping(value: unknown): value is TenantMapping {
  return (
    isRecord(value) &&
    isUuid(value.organizationId) &&
    isUuid(value.recipientIssuerId) &&
    typeof value.recipientRuc === 'string' &&
    /^\d{11}$/u.test(value.recipientRuc)
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
