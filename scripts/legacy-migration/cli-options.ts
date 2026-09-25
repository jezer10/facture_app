import { LegacyMigrationError, type MigrationMode } from './models';

export interface LegacyMigrationCliOptions {
  readonly localRoot: string;
  readonly mappingFile: string;
  readonly mode: MigrationMode;
  readonly skipLegacyDatabase: boolean;
  readonly skipLocal: boolean;
}

const DEFAULT_LOCAL_ROOT = '/home/jzr/Documentos/personal/facture_app';

export function parseCliOptions(argv: readonly string[]): LegacyMigrationCliOptions {
  let mappingFile: string | undefined;
  let localRoot = DEFAULT_LOCAL_ROOT;
  let mode: MigrationMode = 'dry-run';
  let skipLegacyDatabase = false;
  let skipLocal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--apply') {
      mode = 'apply';
    } else if (argument === '--skip-legacy-db') {
      skipLegacyDatabase = true;
    } else if (argument === '--skip-local') {
      skipLocal = true;
    } else if (argument === '--mapping') {
      mappingFile = requiredFollowingValue(argv, ++index, '--mapping');
    } else if (argument === '--local-root') {
      localRoot = requiredFollowingValue(argv, ++index, '--local-root');
    } else {
      throw new LegacyMigrationError(
        'INVALID_ARGUMENTS',
        'The migration command received an unsupported argument',
      );
    }
  }
  if (!mappingFile) {
    throw new LegacyMigrationError('MAPPING_FILE_REQUIRED', 'A tenant mapping file is required');
  }
  if (skipLegacyDatabase && skipLocal) {
    throw new LegacyMigrationError(
      'NO_SOURCE_SELECTED',
      'At least one legacy source must be enabled',
    );
  }
  return { localRoot, mappingFile, mode, skipLegacyDatabase, skipLocal };
}

function requiredFollowingValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new LegacyMigrationError('INVALID_ARGUMENTS', `The ${option} option requires a value`);
  }
  return value;
}
