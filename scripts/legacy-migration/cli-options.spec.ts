import { parseCliOptions } from './cli-options';
import { LegacyMigrationError } from './models';

describe('legacy migration CLI options', () => {
  it('defaults to dry-run and enables apply only through the explicit flag', () => {
    expect(parseCliOptions(['--mapping', '/safe/mapping.json']).mode).toBe('dry-run');
    expect(parseCliOptions(['--mapping', '/safe/mapping.json', '--apply']).mode).toBe('apply');
  });

  it('rejects unknown options and a run with no enabled source', () => {
    expect(() => parseCliOptions(['--mapping', '/safe/mapping.json', '--unknown'])).toThrow(
      LegacyMigrationError,
    );
    expect(() =>
      parseCliOptions(['--mapping', '/safe/mapping.json', '--skip-legacy-db', '--skip-local']),
    ).toThrow('At least one legacy source must be enabled');
  });
});
