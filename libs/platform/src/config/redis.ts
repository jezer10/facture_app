import type { ConnectionOptions } from 'bullmq';
import { readSecretFile } from './secret-file';

export function redisOptionsFromUrl(redisUrl: string, passwordFile?: string): ConnectionOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }

  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(database) || database < 0) {
    throw new Error('REDIS_URL contains an invalid database number');
  }

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: passwordFile
      ? readSecretFile(passwordFile).toString('utf8')
      : url.password
        ? decodeURIComponent(url.password)
        : undefined,
    db: database,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
  };
}

export function databaseUrlWithPassword(databaseUrl: string, passwordFile?: string): string {
  if (!passwordFile) {
    return databaseUrl;
  }
  const url = new URL(databaseUrl);
  url.password = readSecretFile(passwordFile).toString('utf8');
  return url.toString();
}
