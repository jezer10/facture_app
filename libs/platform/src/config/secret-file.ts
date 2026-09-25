import { readFileSync, statSync } from 'node:fs';

export function readSecretFile(path: string, expectedBytes?: number): Buffer {
  const stat = statSync(path);
  const isPrivateHostFile = (stat.mode & 0o077) === 0;
  const isReadOnlyComposeSecret = path.startsWith('/run/secrets/') && (stat.mode & 0o222) === 0;
  if (!stat.isFile() || (!isPrivateHostFile && !isReadOnlyComposeSecret)) {
    throw new Error(
      `Secret must be a regular 0600 file or a read-only /run/secrets mount: ${path}`,
    );
  }

  const text = readFileSync(path, 'utf8').trim();
  if (!text) {
    throw new Error(`Secret file is empty: ${path}`);
  }

  const raw = Buffer.from(text, 'utf8');
  let secret = raw;
  if (expectedBytes !== undefined && raw.length !== expectedBytes) {
    const decoded = Buffer.from(text, 'base64');
    const isCanonicalBase64 =
      decoded.toString('base64').replace(/=+$/u, '') === text.replace(/=+$/u, '');
    if (isCanonicalBase64) {
      secret = decoded;
    }
  }

  if (expectedBytes !== undefined && secret.length !== expectedBytes) {
    throw new Error(`Secret file ${path} must contain exactly ${expectedBytes} bytes`);
  }
  return secret;
}
