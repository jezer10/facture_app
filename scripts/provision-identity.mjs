#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: {
    profile: { type: 'string' },
    account: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});
if (!values.profile || !/^\d{12}$/.test(values.account ?? ''))
  throw new Error('Use --profile <profile> --account <12 digits> [--apply]');
const region = 'us-east-1';
const poolName = 'platform-identity-dev';
const clientName = 'facture-web-dev';
const domain = `platform-dev-${values.account}`;
const origin = 'http://127.0.0.1:5173';
function aws(service, operation, input = {}) {
  // Private temporary JSON keeps parameters out of shell interpolation.
  const dir = mkdtempSync(resolve(tmpdir(), 'identity-'));
  const file = resolve(dir, 'input.json');
  writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  try {
    return JSON.parse(
      execFileSync(
        'aws',
        [
          service,
          operation,
          '--profile',
          values.profile,
          '--region',
          region,
          '--cli-input-json',
          `file://${file}`,
          '--output',
          'json',
        ],
        { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      ) || '{}',
    );
  } catch {
    throw new Error(`AWS ${service} ${operation} failed. No secret response was printed.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const identity = aws('sts', 'get-caller-identity');
if (identity.Account !== values.account) throw new Error('AWS account mismatch');
const pools = aws('cognito-idp', 'list-user-pools', { MaxResults: 60 });
if (pools.NextToken)
  throw new Error('More than 60 pools: select the pool explicitly before provisioning.');
const matching = pools.UserPools.filter((pool) => pool.Name === poolName);
if (matching.length > 1) throw new Error('Ambiguous pool name');
if (!values.apply) {
  console.log(
    JSON.stringify(
      {
        account: identity.Account,
        region,
        poolName,
        existingPool: matching[0]?.Id ?? null,
        clientName,
        domain,
        callback: `${origin}/api/v1/auth/callback`,
        tier: 'ESSENTIALS',
        createsUsers: false,
        enablesNativePasswordLogin: true,
        modifiesSndr: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const poolId =
  matching[0]?.Id ??
  aws('cognito-idp', 'create-user-pool', {
    PoolName: poolName,
    UserPoolTier: 'ESSENTIALS',
    DeletionProtection: 'ACTIVE',
    UsernameAttributes: ['email'],
    AutoVerifiedAttributes: ['email'],
    UsernameConfiguration: { CaseSensitive: false },
    Policies: {
      PasswordPolicy: {
        MinimumLength: 12,
        RequireUppercase: true,
        RequireLowercase: true,
        RequireNumbers: true,
        RequireSymbols: true,
        TemporaryPasswordValidityDays: 7,
      },
    },
    AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    UserPoolTags: { project: 'platform-identity', environment: 'development' },
  }).UserPool.Id;
const clients = aws('cognito-idp', 'list-user-pool-clients', {
  UserPoolId: poolId,
  MaxResults: 60,
});
if (clients.NextToken) throw new Error('Client pagination requires manual selection.');
const existing = clients.UserPoolClients.filter((client) => client.ClientName === clientName);
if (existing.length > 1) throw new Error('Ambiguous client name');
let client = existing[0]
  ? aws('cognito-idp', 'describe-user-pool-client', {
      UserPoolId: poolId,
      ClientId: existing[0].ClientId,
    }).UserPoolClient
  : aws('cognito-idp', 'create-user-pool-client', {
      UserPoolId: poolId,
      ClientName: clientName,
      GenerateSecret: true,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email'],
      CallbackURLs: [`${origin}/api/v1/auth/callback`],
      LogoutURLs: [`${origin}/conexion`],
      SupportedIdentityProviders: ['COGNITO'],
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_PASSWORD_AUTH'],
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
      AccessTokenValidity: 15,
      IdTokenValidity: 15,
      RefreshTokenValidity: 1,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
    }).UserPoolClient;
if (!client.ClientSecret || !client.CallbackURLs?.includes(`${origin}/api/v1/auth/callback`))
  throw new Error('Existing client incompatible. Review instead of overwriting it.');
// Update uses replace semantics: preserve every writable setting from describe.
if (!client.ExplicitAuthFlows?.includes('ALLOW_USER_PASSWORD_AUTH')) {
  const {
    ClientSecret: _secret,
    CreationDate: _created,
    LastModifiedDate: _modified,
    ...settings
  } = client;
  const updated = aws('cognito-idp', 'update-user-pool-client', {
    ...settings,
    ExplicitAuthFlows: [
      ...new Set([...(settings.ExplicitAuthFlows ?? []), 'ALLOW_USER_PASSWORD_AUTH']),
    ],
  }).UserPoolClient;
  client = { ...updated, ClientSecret: client.ClientSecret };
}

const existingDomain = aws('cognito-idp', 'describe-user-pool-domain', {
  Domain: domain,
}).DomainDescription;
if (existingDomain.UserPoolId && existingDomain.UserPoolId !== poolId)
  throw new Error('Domain belongs to another pool');
if (!existingDomain.UserPoolId)
  aws('cognito-idp', 'create-user-pool-domain', {
    UserPoolId: poolId,
    Domain: domain,
    ManagedLoginVersion: 2,
  });
// Preserve an existing branding configuration. Only create the default on a new client.
if (!existing[0])
  aws('cognito-idp', 'create-managed-login-branding', {
    UserPoolId: poolId,
    ClientId: client.ClientId,
    UseCognitoProvidedValues: true,
  });
const directory = resolve('deploy/secrets/local');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const secretPath = resolve(directory, 'cognito_client_secret');
writeFileSync(secretPath, `${client.ClientSecret}\n`, { mode: 0o600 });
chmodSync(secretPath, 0o600);
const config = {
  BILLING_COGNITO_POOL_ID: poolId,
  BILLING_COGNITO_CLIENT_ID: client.ClientId,
  BILLING_COGNITO_DOMAIN: `https://${domain}.auth.${region}.amazoncognito.com`,
  BILLING_COGNITO_CLIENT_SECRET_FILE: secretPath,
  BILLING_WEB_ORIGIN: origin,
};
writeFileSync(resolve(directory, 'identity-config.json'), `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify(
    {
      account: identity.Account,
      region,
      poolId,
      clientId: client.ClientId,
      domain: config.BILLING_COGNITO_DOMAIN,
      configFile: 'deploy/secrets/local/identity-config.json',
      usersCreated: 0,
    },
    null,
    2,
  ),
);
