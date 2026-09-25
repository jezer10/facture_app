import {
  isPublicWebhookAddress,
  normalizeWebhookEndpointUrl,
  resolveWebhookEndpoint,
} from './webhook-endpoint';
import { PermanentWebhookDeliveryError } from './webhook.errors';

describe('webhook endpoint security', () => {
  it.each([
    'https://127.0.0.1/hooks',
    'https://169.254.169.254/latest/meta-data',
    'https://10.10.10.10/hooks',
    'https://[::1]/hooks',
    'https://[::ffff:7f00:1]/hooks',
    'https://metadata.google.internal/hooks',
    'https://service.local/hooks',
  ])('rejects a local or non-public endpoint literal: %s', (endpointUrl) => {
    expect(() => normalizeWebhookEndpointUrl(endpointUrl)).toThrow(PermanentWebhookDeliveryError);
  });

  it('rejects every DNS answer when any address is non-public', async () => {
    await expect(
      resolveWebhookEndpoint('https://receiver.example/hooks', {
        resolveHostname: () =>
          Promise.resolve([
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.7', family: 4 },
          ]),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_ENDPOINT', retryable: false });
  });

  it('returns a verified public address for the transport to pin', async () => {
    await expect(
      resolveWebhookEndpoint('https://receiver.example/hooks', {
        resolveHostname: (hostname) => {
          expect(hostname).toBe('receiver.example');
          return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
        },
      }),
    ).resolves.toMatchObject({
      address: '93.184.216.34',
      family: 4,
      hostname: 'receiver.example',
    });
  });

  it('allows loopback HTTP only with the explicit local-development policy', async () => {
    await expect(
      resolveWebhookEndpoint('http://localhost:8080/hooks', {
        allowInsecureLocalEndpoints: true,
        resolveHostname: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      }),
    ).resolves.toMatchObject({ address: '127.0.0.1', family: 4 });

    expect(() => normalizeWebhookEndpointUrl('http://localhost:8080/hooks')).toThrow(
      PermanentWebhookDeliveryError,
    );
  });

  it('classifies globally routable and special-purpose addresses conservatively', () => {
    expect(isPublicWebhookAddress('8.8.8.8')).toBe(true);
    expect(isPublicWebhookAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicWebhookAddress('100.64.0.1')).toBe(false);
    expect(isPublicWebhookAddress('192.0.2.1')).toBe(false);
    expect(isPublicWebhookAddress('2001:db8::1')).toBe(false);
    expect(isPublicWebhookAddress('fc00::1')).toBe(false);
  });
});
