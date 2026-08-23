import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadGatewayException } from '@nestjs/common';
import { InternalBillingServicesClient } from './internal-billing-services.client';

const ISSUER_ID = '11111111-1111-4111-8111-111111111111';
const SUNAT_SECRET = 's'.repeat(32);
const WEBHOOK_SECRET = 'w'.repeat(32);

describe('InternalBillingServicesClient', () => {
  let temporaryDirectory: string;
  let sunatSecretPath: string;
  let webhookSecretPath: string;
  const originalEnvironment = { ...process.env };

  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'billing-internal-client-'));
    sunatSecretPath = join(temporaryDirectory, 'sunat-internal-secret');
    webhookSecretPath = join(temporaryDirectory, 'webhook-internal-secret');
    writeFileSync(sunatSecretPath, SUNAT_SECRET, {
      encoding: 'utf8',
      mode: 0o600,
    });
    writeFileSync(webhookSecretPath, WEBHOOK_SECRET, {
      encoding: 'utf8',
      mode: 0o600,
    });
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.BILLING_SERVICE = 'billing-api';
    process.env.SUNAT_INTERNAL_SERVICE_SECRET_FILE = sunatSecretPath;
    process.env.WEBHOOK_INTERNAL_SERVICE_SECRET_FILE = webhookSecretPath;
    process.env.SUNAT_INTERNAL_URL = 'http://sunat.internal:3002';
    process.env.WEBHOOK_INTERNAL_URL = 'http://webhooks.internal:3003';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnvironment };
  });

  afterAll(() => {
    rmSync(temporaryDirectory, { recursive: true });
  });

  it('uses the SUNAT-specific base64url bearer and validates the upstream response', async () => {
    const response = {
      configured: false,
      issuerId: ISSUER_ID,
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    const client = new InternalBillingServicesClient();

    await expect(client.getSunatCredential(ISSUER_ID)).resolves.toEqual(response);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      `http://sunat.internal:3002/internal/issuers/${ISSUER_ID}/sunat-credentials`,
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${Buffer.from(SUNAT_SECRET).toString('base64url')}`,
    );
    expect(init?.redirect).toBe('error');
  });

  it('uses a different bearer for the webhook upstream', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const client = new InternalBillingServicesClient();

    await expect(
      client.listWebhookSubscriptions('22222222-2222-4222-8222-222222222222'),
    ).resolves.toEqual([]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      'http://webhooks.internal:3003/internal/organizations/22222222-2222-4222-8222-222222222222/webhook-subscriptions',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${Buffer.from(WEBHOOK_SECRET).toString('base64url')}`,
    );
  });

  it('rejects reuse of one bearer across both internal upstreams', () => {
    process.env.WEBHOOK_INTERNAL_SERVICE_SECRET_FILE = sunatSecretPath;

    expect(() => new InternalBillingServicesClient()).toThrow(
      'SUNAT and webhook internal service secrets must contain different values',
    );
  });

  it('rejects malformed internal responses at the trust boundary', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ configured: 'yes' }), { status: 200 }));
    const client = new InternalBillingServicesClient();

    await expect(client.getSunatCredential(ISSUER_ID)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

function requestUrl(value: string | URL | Request | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  return value?.url;
}
