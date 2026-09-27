import { readSecretFile } from '@app/platform';

export interface BrowserAuthConfig {
  readonly poolId: string;
  readonly clientId: string;
  readonly domain: string;
  readonly origin: string;
  readonly clientSecret: string;
  readonly secure: boolean;
}
export function browserAuthConfig(env = process.env): BrowserAuthConfig | null {
  const central = Boolean(env.BILLING_IDENTITY_ISSUER);
  const values = [
    env.BILLING_COGNITO_POOL_ID,
    central ? env.BILLING_IDENTITY_CLIENT_ID : env.BILLING_COGNITO_CLIENT_ID,
    central ? env.BILLING_IDENTITY_ISSUER : env.BILLING_COGNITO_DOMAIN,
    central ? env.BILLING_IDENTITY_CLIENT_SECRET_FILE : env.BILLING_COGNITO_CLIENT_SECRET_FILE,
    env.BILLING_WEB_ORIGIN,
  ];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value))
    throw new Error(
      'Cognito configuration requires pool, client, domain, client secret file and web origin',
    );
  const [poolId, clientId, domainValue, secretPath, originValue] = values as [
    string,
    string,
    string,
    string,
    string,
  ];
  const domain = new URL(domainValue);
  const origin = new URL(originValue);
  if (
    (domain.protocol !== 'https:' &&
      !(
        central &&
        env.NODE_ENV !== 'production' &&
        domain.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(domain.hostname)
      )) ||
    domain.pathname !== '/' ||
    domain.search ||
    domain.hash ||
    domain.username ||
    domain.password
  )
    throw new Error('Cognito domain must be an HTTPS origin');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    (origin.protocol !== 'https:' &&
      !(env.NODE_ENV !== 'production' && loopback && origin.protocol === 'http:')) ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error('Web origin must use HTTPS (HTTP loopback only in development)');
  if (
    !/^[a-z]{2}(?:-[a-z]+)+-\d_[A-Za-z0-9]+$/u.test(poolId) ||
    !(central ? /^[A-Za-z0-9_-]+$/u : /^[a-z0-9]+$/u).test(clientId)
  )
    throw new Error('Invalid Cognito pool or client id');
  return {
    poolId,
    clientId,
    domain: domain.origin,
    origin: origin.origin,
    clientSecret: readSecretFile(secretPath).toString('utf8'),
    secure: origin.protocol === 'https:',
  };
}
