import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { DataSource } from 'typeorm';
import { BrowserSessionService, cookieValue, digest } from './browser-session.service';
import * as config from './browser-auth.config';
const origin = 'http://127.0.0.1:5173';
const token = 'a'.repeat(43);
const orgId = '11111111-1111-4111-8111-111111111111';
const session = {
  token_hash: digest(token),
  subject: 'cognito:us-east-1_test:user',
  email: 'test@example.test',
  csrf_token: 'csrf-test',
  organization_id: orgId,
  expires_at: new Date(Date.now() + 60000),
};
const member = { id: orgId, name: 'Development', role: 'viewer' };
function req(headers: Record<string, string> = {}, method = 'GET'): Request {
  return { method, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}
function harness(): { service: BrowserSessionService; query: jest.Mock } {
  jest.spyOn(config, 'browserAuthConfig').mockReturnValue({
    poolId: 'us-east-1_test',
    clientId: 'client1',
    domain: 'https://example.auth.us-east-1.amazoncognito.com',
    origin,
    clientSecret: 'test-secret',
    secure: false,
  });
  const query = jest.fn();
  return { service: new BrowserSessionService({ query } as unknown as DataSource), query };
}
afterEach(() => jest.restoreAllMocks());
it('builds a PKCE authorization request and keeps only hashed state/browser binding', async () => {
  const { service, query } = harness();
  query.mockResolvedValue([]);
  const result = await service.begin();
  const url = new URL(result.url);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/api/v1/auth/callback`);
  expect(url.searchParams.get('client_secret')).toBeNull();
  const calls = query.mock.calls as unknown[][];
  const parameters = calls[2]?.[1] as string[];
  expect(parameters[0]).toBe(digest(url.searchParams.get('state')!));
  expect(parameters[1]).toBe(digest(result.binding));
  expect(parameters[3]).toBe(url.searchParams.get('nonce'));
});
it('rejects mismatched, expired or already consumed callbacks before token exchange', async () => {
  const { service, query } = harness();
  query.mockResolvedValue([]);
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  await expect(service.finish('code', token, 'b'.repeat(43))).rejects.toBeInstanceOf(
    UnauthorizedException,
  );
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM browser_login_attempts'),
    [digest(token), digest('b'.repeat(43))],
  );
  expect(fetchSpy).not.toHaveBeenCalled();
});
it('returns a disabled session without touching the database when unconfigured', async () => {
  jest.spyOn(config, 'browserAuthConfig').mockReturnValue(null);
  const query = jest.fn();
  const service = new BrowserSessionService({ query } as unknown as DataSource);
  expect(await service.view(req())).toEqual({ enabled: false, authenticated: false });
  expect(query).not.toHaveBeenCalled();
});
it('rejects missing, duplicate, or malformed session cookies', () => {
  expect(cookieValue(req(), 'facture_session')).toBe('');
  expect(cookieValue(req({ cookie: 'facture_session=invalid' }), 'facture_session')).toBe('');
  expect(
    cookieValue(
      req({ cookie: `facture_session=${token}; facture_session=${token}` }),
      'facture_session',
    ),
  ).toBe('');
  expect(cookieValue(req({ cookie: `other=1; facture_session=${token}` }), 'facture_session')).toBe(
    token,
  );
});
it('requires both trusted origin and CSRF token for cookie-authenticated writes', async () => {
  for (const headers of [
    { origin: 'https://attacker.test', 'x-csrf-token': 'csrf-test' },
    { origin, 'x-csrf-token': 'wrong' },
  ]) {
    const { service, query } = harness();
    query.mockResolvedValue([session]);
    await expect(
      service.principal(req({ cookie: `facture_session=${token}`, ...headers }, 'POST')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).toHaveBeenCalledTimes(1);
  }
});
it('rechecks membership on every request, preserving role and never granting platform admin', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([session]).mockResolvedValueOnce([member]);
  expect(await service.principal(req({ cookie: `facture_session=${token}` }))).toEqual({
    kind: 'human',
    subject: session.subject,
    organizationId: orgId,
    role: 'viewer',
    platformAdmin: false,
  });
  query.mockResolvedValueOnce([session]).mockResolvedValueOnce([]);
  await expect(
    service.principal(req({ cookie: `facture_session=${token}` })),
  ).rejects.toBeInstanceOf(ForbiddenException);
});
it('does not expose tokens or authorize an unassigned account', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([{ ...session, organization_id: null }]).mockResolvedValueOnce([]);
  const result = await service.view(req({ cookie: `facture_session=${token}` }));
  expect(result.authenticated).toBe(true);
  expect(result.organizations).toEqual([]);
  expect(result.organizationId).toBeNull();
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain('token_hash');
});
it('rejects selecting another tenant and does not update the session', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([session]).mockResolvedValueOnce([member]);
  await expect(
    service.select(
      req({ cookie: `facture_session=${token}`, origin, 'x-csrf-token': 'csrf-test' }, 'POST'),
      'other-tenant',
    ),
  ).rejects.toBeInstanceOf(ForbiddenException);
  expect(query).toHaveBeenCalledTimes(2);
});
it('logs out by deleting the server session and uses only the configured logout destination', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([session]).mockResolvedValueOnce([]);
  const url = new URL(
    await service.logout(
      req({ cookie: `facture_session=${token}`, origin, 'x-csrf-token': 'csrf-test' }, 'POST'),
    ),
  );
  expect(query).toHaveBeenLastCalledWith('DELETE FROM browser_sessions WHERE token_hash=$1', [
    digest(token),
  ]);
  expect(url.searchParams.get('logout_uri')).toBe(`${origin}/conexion`);
});

it('creates a bounded server session after validating both tokens and consumes only approved invitations', async () => {
  const { service, query } = harness();
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const verifiers = service as unknown as {
    idVerifier: { verify: jest.Mock };
    accessVerifier: { verify: jest.Mock };
  };
  jest.spyOn(verifiers.idVerifier, 'verify').mockResolvedValue({
    sub: 'user',
    nonce: 'expected-nonce',
    email_verified: true,
    email: 'Test@Example.test',
    exp: expiry,
  });
  jest.spyOn(verifiers.accessVerifier, 'verify').mockResolvedValue({ sub: 'user', exp: expiry });
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        id_token: 'id-token-only-on-server',
        access_token: 'access-token-only-on-server',
        refresh_token: 'refresh-token-discarded',
      }),
      { status: 200 },
    ),
  );
  const invitationQuery = jest
    .fn()
    .mockResolvedValueOnce([{ organization_id: orgId, role: 'owner' }])
    .mockResolvedValueOnce([]);
  const db = service as unknown as { database: { transaction: unknown } };
  db.database.transaction = async (
    callback: (manager: { query: typeof invitationQuery }) => Promise<void>,
  ) => callback({ query: invitationQuery });
  query
    .mockResolvedValueOnce([{ verifier: 'verifier', nonce: 'expected-nonce' }])
    .mockResolvedValueOnce([member])
    .mockResolvedValueOnce([]);
  const result = await service.finish('code', token, 'b'.repeat(43));
  expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 900000);
  expect(invitationQuery).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining('claimed_subject IS NULL'),
    ['cognito:us-east-1_test:user', 'test@example.test'],
  );
  expect(invitationQuery).toHaveBeenNthCalledWith(
    2,
    expect.stringContaining('ON CONFLICT(organization_id,subject) DO NOTHING'),
    [expect.any(String), orgId, 'cognito:us-east-1_test:user', 'owner'],
  );
  const serialized = JSON.stringify(query.mock.calls);
  expect(serialized).not.toContain(result.token);
  expect(serialized).not.toContain('id-token-only-on-server');
  expect(serialized).not.toContain('access-token-only-on-server');
  expect(serialized).not.toContain('refresh-token-discarded');
});

it.each(['nonce', 'subject', 'verification'])(
  'rejects an identity with invalid %s before granting membership',
  async (failure) => {
    const { service, query } = harness();
    const expiry = Math.floor(Date.now() / 1000) + 900;
    const verifiers = service as unknown as {
      idVerifier: { verify: jest.Mock };
      accessVerifier: { verify: jest.Mock };
    };
    jest.spyOn(verifiers.idVerifier, 'verify').mockResolvedValue({
      sub: 'user',
      nonce: failure === 'nonce' ? 'wrong' : 'expected',
      email_verified: failure !== 'verification',
      email: 'test@example.test',
      exp: expiry,
    });
    jest
      .spyOn(verifiers.accessVerifier, 'verify')
      .mockResolvedValue({ sub: failure === 'subject' ? 'attacker' : 'user', exp: expiry });
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id_token: 'id', access_token: 'access' }), { status: 200 }),
      );
    query.mockResolvedValueOnce([{ verifier: 'verifier', nonce: 'expected' }]);
    await expect(service.finish('code', token, 'b'.repeat(43))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(query).toHaveBeenCalledTimes(1);
  },
);
