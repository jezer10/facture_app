import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Request } from 'express';
import { PlatformIdentityClient } from './platform-identity.client';
import * as platformConfig from './platform-identity.client';
import * as browserConfig from './browser-auth.config';
import { BrowserSessionService, digest } from './browser-session.service';
const cfg = {
  issuer: 'http://127.0.0.1:5180',
  clientId: 'facture-web',
  clientSecret: 'secret',
  key: randomBytes(32),
};
const token = 'a'.repeat(43);
const origin = 'http://127.0.0.1:5173';
const row = {
  token_hash: digest(token),
  subject: 'cognito:us-east-1_test:user',
  email: 'user@example.test',
  csrf_token: 'csrf',
  organization_id: null,
  expires_at: new Date(Date.now() + 60000),
};
function request(): Request {
  return {
    get: (name: string) =>
      ({ cookie: `facture_session=${token}`, origin, 'x-csrf-token': 'csrf' })[name],
  } as Request;
}
function harness(): { query: jest.Mock; service: BrowserSessionService } {
  jest.spyOn(platformConfig, 'platformIdentityConfig').mockReturnValue(cfg);
  jest.spyOn(browserConfig, 'browserAuthConfig').mockReturnValue({
    poolId: 'us-east-1_test',
    clientId: 'facture-web',
    clientSecret: 'secret',
    domain: cfg.issuer,
    origin,
    secure: false,
  });
  const query = jest.fn();
  const service = new BrowserSessionService({ query } as unknown as DataSource);
  return { query, service };
}
afterEach(() => jest.restoreAllMocks());
it('encrypts stored access tokens and rejects tampering or a different key', () => {
  const c = new PlatformIdentityClient(cfg);
  const encrypted = c.seal('secret-access-token');
  expect(encrypted).not.toContain('secret-access-token');
  expect(c.open(encrypted)).toBe('secret-access-token');
  expect(() =>
    new PlatformIdentityClient({ ...cfg, key: randomBytes(32) }).open(encrypted),
  ).toThrow();
});
it('uses platform authorization with the registered client and PKCE', async () => {
  const { service, query } = harness();
  query.mockResolvedValue([]);
  const { url } = await service.begin();
  const u = new URL(url);
  expect(u.origin).toBe(cfg.issuer);
  expect(u.pathname).toBe('/oidc/auth');
  expect(u.searchParams.get('client_id')).toBe('facture-web');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
});
it('rejects legacy native token sessions when central login is enabled', async () => {
  const { service } = harness();
  await expect(service.fromIdentityTokens('old-id', 'old-access')).rejects.toBeInstanceOf(
    UnauthorizedException,
  );
});
it('removes the local session after central revocation', async () => {
  const { service, query } = harness();
  const c = new PlatformIdentityClient(cfg);
  query
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce([{ encrypted_access_token: c.seal('access') }])
    .mockResolvedValueOnce([]);
  jest.spyOn(PlatformIdentityClient.prototype, 'introspect').mockResolvedValue({ active: false });
  expect(await service.view(request())).toEqual({
    enabled: true,
    authenticated: false,
    loginMode: 'central',
  });
  expect(query).toHaveBeenLastCalledWith('DELETE FROM browser_sessions WHERE token_hash=$1', [
    digest(token),
  ]);
});
it('does not authorize while central session verification is unavailable', async () => {
  const { service, query } = harness();
  query
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce([
      { encrypted_access_token: new PlatformIdentityClient(cfg).seal('access') },
    ]);
  jest
    .spyOn(PlatformIdentityClient.prototype, 'introspect')
    .mockRejectedValue(new ServiceUnavailableException());
  await expect(service.view(request())).rejects.toBeInstanceOf(ServiceUnavailableException);
});
it('keeps local and suite logout separate', async () => {
  for (const global of [false, true]) {
    const { service, query } = harness();
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.startsWith('SELECT token_hash')
          ? [row]
          : sql.startsWith('SELECT encrypted')
            ? [{ encrypted_access_token: new PlatformIdentityClient(cfg).seal('access') }]
            : [],
      ),
    );
    jest
      .spyOn(PlatformIdentityClient.prototype, 'introspect')
      .mockResolvedValue({ active: true, sub: row.subject, client_id: cfg.clientId });
    const url = new URL(await service.logout(request(), global));
    expect(url.origin).toBe(global ? cfg.issuer : origin);
    expect(url.pathname).toBe(global ? '/oidc/session/end' : '/conexion');
    jest.restoreAllMocks();
  }
});
