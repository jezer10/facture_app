import type { S3Client } from '@aws-sdk/client-s3';

import { databaseUrlWithPassword } from '../../libs/platform/src/config/redis';
import { readSecretFile } from '../../libs/platform/src/config/secret-file';

import {
  FilesystemArtifactReaderAdapter,
  FilesystemLocalInvoiceSourceAdapter,
} from './adapters/filesystem-local-source';
import { JsonTenantMappingAdapter } from './adapters/json-tenant-mapping';
import {
  createR2Client,
  R2DestinationObjectStoreAdapter,
  R2LegacyArtifactReaderAdapter,
  RoutedArtifactReaderAdapter,
  type R2ConnectionOptions,
} from './adapters/s3-object-store';
import { TypeormBillingDestinationAdapter } from './adapters/typeorm-billing-destination';
import { TypeormLegacyDatabaseSourceAdapter } from './adapters/typeorm-legacy-source';
import { parseCliOptions } from './cli-options';
import { LegacyMigrationEngine } from './migration-engine';
import { LegacyMigrationError } from './models';

interface Environment {
  readonly [name: string]: string | undefined;
}

export async function runLegacyMigrationCli(
  argv: readonly string[],
  environment: Environment,
): Promise<number> {
  const options = parseCliOptions(argv);
  const mapping = await JsonTenantMappingAdapter.fromFile(options.mappingFile);
  const destinationDatabaseUrl = databaseConnectionUrl(
    requiredEnvironment(environment, 'CORE_DATABASE_URL'),
    environment.CORE_DATABASE_PASSWORD_FILE,
  );
  const destinationR2Options = destinationR2(environment);
  const destinationClient = createR2Client(destinationR2Options);
  const destination = await TypeormBillingDestinationAdapter.connect(
    destinationDatabaseUrl,
    environment.BILLING_CORE_SCHEMA ?? 'public',
  );
  let legacyDatabase: TypeormLegacyDatabaseSourceAdapter | undefined;
  let legacyClient: S3Client | undefined;
  try {
    const useLegacyDatabase =
      !options.skipLegacyDatabase && Boolean(environment.LEGACY_DATABASE_URL);
    if (useLegacyDatabase) {
      legacyDatabase = await TypeormLegacyDatabaseSourceAdapter.connect(
        databaseConnectionUrl(
          requiredEnvironment(environment, 'LEGACY_DATABASE_URL'),
          environment.LEGACY_DATABASE_PASSWORD_FILE,
        ),
        environment.LEGACY_DATABASE_SCHEMA ?? 'public',
      );
      const legacyR2Options = legacyR2(environment);
      legacyClient = createR2Client(legacyR2Options);
    }

    const localInvoices = options.skipLocal
      ? undefined
      : new FilesystemLocalInvoiceSourceAdapter(options.localRoot);
    const localReader = options.skipLocal
      ? undefined
      : new FilesystemArtifactReaderAdapter(options.localRoot);
    const legacyReader = legacyClient
      ? new R2LegacyArtifactReaderAdapter(
          legacyClient,
          requiredEnvironment(environment, 'LEGACY_INVOICE_R2_BUCKET', 'INVOICE_R2_BUCKET'),
        )
      : undefined;
    const engine = new LegacyMigrationEngine({
      artifactReader: new RoutedArtifactReaderAdapter(localReader, legacyReader),
      destination,
      destinationObjects: new R2DestinationObjectStoreAdapter(
        destinationClient,
        destinationR2Options.bucket,
      ),
      ...(legacyDatabase ? { legacyDatabase } : {}),
      ...(localInvoices ? { localInvoices } : {}),
      mapping,
    });
    const report = await engine.run(options.mode);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === 'completed' ? 0 : 2;
  } finally {
    await legacyDatabase?.close();
    await destination.close();
    legacyClient?.destroy();
    destinationClient.destroy();
  }
}

function destinationR2(environment: Environment): R2ConnectionOptions {
  return {
    accessKeyId: secretFromFile(environment, 'R2_ACCESS_KEY_ID_FILE'),
    bucket: requiredEnvironment(environment, 'R2_BUCKET'),
    endpoint: requiredEnvironment(environment, 'R2_ENDPOINT'),
    secretAccessKey: secretFromFile(environment, 'R2_SECRET_ACCESS_KEY_FILE'),
  };
}

function legacyR2(environment: Environment): R2ConnectionOptions {
  const endpoint =
    environment.LEGACY_R2_ENDPOINT ??
    (environment.CLOUDFLARE_ACCOUNT_ID
      ? `https://${environment.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined);
  if (!endpoint) {
    throw new LegacyMigrationError(
      'MISSING_ENVIRONMENT',
      'Legacy R2 endpoint configuration is required when the database source is enabled',
    );
  }
  return {
    accessKeyId: secretFromPreferredFile(
      environment,
      'LEGACY_R2_ACCESS_KEY_ID_FILE',
      'LEGACY_R2_ACCESS_KEY_ID',
      'CLOUDFLARE_R2_ACCESS_KEY_ID',
    ),
    bucket: requiredEnvironment(environment, 'LEGACY_INVOICE_R2_BUCKET', 'INVOICE_R2_BUCKET'),
    endpoint,
    secretAccessKey: secretFromPreferredFile(
      environment,
      'LEGACY_R2_SECRET_ACCESS_KEY_FILE',
      'LEGACY_R2_SECRET_ACCESS_KEY',
      'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    ),
  };
}

function secretFromFile(environment: Environment, name: string): string {
  const path = requiredEnvironment(environment, name);
  try {
    return readSecretFile(path).toString('utf8');
  } catch (error) {
    throw new LegacyMigrationError(
      'INVALID_SECRET_FILE',
      'A required secret file could not be read',
      { cause: error },
    );
  }
}

function secretFromPreferredFile(
  environment: Environment,
  fileName: string,
  valueName: string,
  legacyValueName: string,
): string {
  return environment[fileName]
    ? secretFromFile(environment, fileName)
    : requiredEnvironment(environment, valueName, legacyValueName);
}

function databaseConnectionUrl(databaseUrl: string, passwordFile?: string): string {
  try {
    return databaseUrlWithPassword(databaseUrl, passwordFile);
  } catch (error) {
    throw new LegacyMigrationError(
      'INVALID_DATABASE_CONFIGURATION',
      'Database connection configuration is invalid',
      { cause: error },
    );
  }
}

function requiredEnvironment(
  environment: Environment,
  name: string,
  fallbackName?: string,
): string {
  const value = environment[name] ?? (fallbackName ? environment[fallbackName] : undefined);
  if (!value || value.trim().length === 0) {
    throw new LegacyMigrationError(
      'MISSING_ENVIRONMENT',
      'Required migration environment is not configured',
    );
  }
  return value.trim();
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runLegacyMigrationCli(process.argv.slice(2), process.env);
  } catch (error) {
    const code = error instanceof LegacyMigrationError ? error.code : 'UNEXPECTED_FAILURE';
    process.stderr.write(`${JSON.stringify({ code, status: 'failed' })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
