import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const trackedFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter((path) => Boolean(path) && existsSync(path));
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['jwt-token', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/u],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/u],
];
const findings = [];

for (const path of trackedFiles) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\0')) continue;
  for (const [name, pattern] of rules) {
    const match = pattern.exec(content);
    if (match?.index !== undefined) {
      const line = content.slice(0, match.index).split('\n').length;
      findings.push({ path, line, rule: name });
    }
  }
  content.split('\n').forEach((lineContent, index) => {
    const assignment = /^([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)=(.+)$/u.exec(
      lineContent.trim(),
    );
    if (!assignment?.[1] || assignment[1].endsWith('_FILE')) return;
    const value = assignment[2]?.trim() ?? '';
    if (
      value &&
      !value.startsWith('${') &&
      !value.startsWith('$(') &&
      !value.startsWith('"$(') &&
      !value.startsWith('<')
    ) {
      findings.push({ path, line: index + 1, rule: 'secret-assignment' });
    }
  });
}

if (findings.length > 0) {
  process.stderr.write(`Secret audit failed:\n${findings.map((finding) =>
    `- ${finding.path}:${finding.line} (${finding.rule})`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Secret audit passed (${trackedFiles.length} tracked or pending files checked).\n`,
  );
}
