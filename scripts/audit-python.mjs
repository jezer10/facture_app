import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const forbidden = [
  /(^|\/)__pycache__(\/|$)/u,
  /\.py[cod]?$/u,
  /(^|\/)pyproject\.toml$/u,
  /(^|\/)uv\.lock$/u,
  /(^|\/)requirements[^/]*\.txt$/u,
  /(^|\/)Pipfile(?:\.lock)?$/u,
];
const trackedFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter((path) => Boolean(path) && existsSync(path));
const residual = trackedFiles.filter((path) => forbidden.some((pattern) => pattern.test(path)));

if (residual.length > 0) {
  process.stderr.write(`Python audit failed; tracked runtime files remain:\n${residual.map((path) => `- ${path}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Python audit passed; tracked or pending files contain no Python runtime.\n',
  );
}
