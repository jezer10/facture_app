import { readSecretFile } from './secret-file';
export function databaseUrlWithPassword(databaseUrl: string, passwordFile?: string): string {
  if (!passwordFile) return databaseUrl;
  const url = new URL(databaseUrl);
  url.password = readSecretFile(passwordFile).toString('utf8');
  return url.toString();
}
