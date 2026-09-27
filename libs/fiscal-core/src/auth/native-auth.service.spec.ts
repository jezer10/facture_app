import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  type InitiateAuthCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import type { DataSource } from 'typeorm';
import { NativeAuthService } from './native-auth.service';
import type { BrowserSessionService } from './browser-session.service';
const config = { poolId: 'us-east-1_test', clientId: 'client', clientSecret: 'server-secret' };
function harness(): {
  service: NativeAuthService;
  query: jest.Mock;
  fromIdentityTokens: jest.Mock;
  invalidateEmailSessions: jest.Mock;
} {
  const query = jest.fn().mockResolvedValue([]),
    fromIdentityTokens = jest
      .fn()
      .mockResolvedValue({ token: 'server-cookie', expiresAt: new Date() }),
    invalidateEmailSessions = jest.fn().mockResolvedValue(undefined);
  return {
    service: new NativeAuthService(
      { config, fromIdentityTokens, invalidateEmailSessions } as unknown as BrowserSessionService,
      { query } as unknown as DataSource,
    ),
    query,
    fromIdentityTokens,
    invalidateEmailSessions,
  };
}
afterEach(() => jest.restoreAllMocks());
it('uses a confidential client and passes provider tokens only to the server verifier', async () => {
  const send = mockSend().mockImplementation(() =>
    Promise.resolve({
      AuthenticationResult: {
        IdToken: 'id-token',
        AccessToken: 'access-token',
        RefreshToken: 'discarded',
      },
    } as InitiateAuthCommandOutput),
  );
  const { service, fromIdentityTokens } = harness();
  expect((await service.login('Person@Example.test', 'Password-test')).step).toBe('authenticated');
  expect(send.mock.calls[0]![0].input).toMatchObject({
    ClientId: 'client',
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: {
      USERNAME: 'person@example.test',
      SECRET_HASH: createHmac('sha256', 'server-secret')
        .update('person@example.testclient')
        .digest('base64'),
    },
  });
  expect(fromIdentityTokens).toHaveBeenCalledWith('id-token', 'access-token');
});
it('does not bypass an MFA challenge or expose the Cognito session in its result', async () => {
  mockSend().mockImplementation(() =>
    Promise.resolve({
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      Session: 'provider-private-session',
      ChallengeParameters: { USERNAME: 'canonical-user' },
    }),
  );
  const { service, query, fromIdentityTokens } = harness();
  const result = await service.login('person@example.test', 'password');
  expect(result.step).toBe('challenge');
  expect(result.binding).toHaveLength(43);
  expect(JSON.stringify(result)).not.toContain('provider-private-session');
  expect(fromIdentityTokens).not.toHaveBeenCalled();
  expect(query).toHaveBeenLastCalledWith(
    expect.stringContaining('INSERT INTO browser_auth_challenges'),
    [expect.any(String), 'canonical-user', 'SOFTWARE_TOKEN_MFA', 'provider-private-session'],
  );
});
it('rejects expired or reused challenges before contacting Cognito', async () => {
  const send = mockSend();
  const { service } = harness();
  await expect(service.challenge('a'.repeat(43), '123456')).rejects.toThrow('venció');
  expect(send).not.toHaveBeenCalled();
});
it('invalidates local sessions only after a successful password reset', async () => {
  const send = mockSend().mockImplementation(() => Promise.resolve({}));
  const { service, invalidateEmailSessions } = harness();
  await service.reset('person@example.test', '123456', 'Password-test');
  expect(invalidateEmailSessions).toHaveBeenCalledTimes(1);
  send.mockImplementation(() =>
    Promise.reject(
      Object.assign(new Error('Sensitive provider details'), { name: 'CodeMismatchException' }),
    ),
  );
  await expect(service.reset('person@example.test', '000000', 'Password-test')).rejects.toThrow(
    'código',
  );
  expect(invalidateEmailSessions).toHaveBeenCalledTimes(1);
});
it('uses the same recovery response when an account does not exist', async () => {
  mockSend().mockImplementation(() =>
    Promise.reject(Object.assign(new Error('Private data'), { name: 'UserNotFoundException' })),
  );
  const { service } = harness();
  expect(await service.forgot('unknown@example.test')).toMatchObject({ step: 'reset' });
});

function mockSend(): jest.SpyInstance<Promise<unknown>, [{ input: unknown }]> {
  return jest.spyOn(CognitoIdentityProviderClient.prototype, 'send') as unknown as jest.SpyInstance<
    Promise<unknown>,
    [{ input: unknown }]
  >;
}
