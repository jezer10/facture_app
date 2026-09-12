import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { PermanentWebhookDeliveryError, TransientWebhookDeliveryError } from './webhook.errors';

export interface WebhookResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ResolvedWebhookEndpoint extends WebhookResolvedAddress {
  readonly hostname: string;
  readonly url: URL;
}

export type WebhookDnsResolver = (hostname: string) => Promise<readonly WebhookResolvedAddress[]>;

export interface WebhookEndpointPolicy {
  readonly allowInsecureLocalEndpoints?: boolean;
  readonly resolveHostname?: WebhookDnsResolver;
}

const blockedIpv4Addresses = createBlockedIpv4Addresses();
const globallyRoutableIpv6Addresses = createGloballyRoutableIpv6Addresses();
const blockedIpv6Addresses = createBlockedIpv6Addresses();

export function normalizeWebhookEndpointUrl(
  value: string,
  policy: WebhookEndpointPolicy = {},
): string {
  return parseWebhookEndpointUrl(value, policy).toString();
}

export async function resolveWebhookEndpoint(
  value: string,
  policy: WebhookEndpointPolicy = {},
): Promise<ResolvedWebhookEndpoint> {
  const url = parseWebhookEndpointUrl(value, policy);
  const hostname = endpointHostname(url);
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 0
      ? await resolveHostname(hostname, policy.resolveHostname ?? defaultDnsResolver)
      : [{ address: hostname, family: literalFamily } as WebhookResolvedAddress];

  if (addresses.length === 0) {
    throw new TransientWebhookDeliveryError(
      'REMOTE_UNAVAILABLE',
      'Webhook endpoint hostname did not resolve to an address',
    );
  }

  for (const resolved of addresses) {
    if (isIP(resolved.address) !== resolved.family) {
      throw new TransientWebhookDeliveryError(
        'REMOTE_UNAVAILABLE',
        'Webhook endpoint hostname returned an invalid address',
      );
    }
    if (policy.allowInsecureLocalEndpoints !== true && !isPublicWebhookAddress(resolved.address)) {
      throw unsafeEndpoint('Webhook endpoint resolves to a non-public network address');
    }
  }

  const selected = addresses[0];
  if (selected === undefined) {
    throw new TransientWebhookDeliveryError(
      'REMOTE_UNAVAILABLE',
      'Webhook endpoint hostname did not resolve to an address',
    );
  }

  return {
    address: selected.address,
    family: selected.family,
    hostname,
    url,
  };
}

export function isPublicWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !blockedIpv4Addresses.check(address, 'ipv4');
  }
  if (family === 6) {
    return (
      globallyRoutableIpv6Addresses.check(address, 'ipv6') &&
      !blockedIpv6Addresses.check(address, 'ipv6')
    );
  }
  return false;
}

function parseWebhookEndpointUrl(value: string, policy: WebhookEndpointPolicy): URL {
  if (value.length > 2_048) {
    throw unsafeEndpoint('Webhook endpoint URL must not exceed 2048 characters');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unsafeEndpoint('Webhook endpoint must be an absolute URL');
  }

  const secureProtocol = url.protocol === 'https:';
  const explicitlyAllowedLocalHttp =
    url.protocol === 'http:' && policy.allowInsecureLocalEndpoints === true;
  if (!secureProtocol && !explicitlyAllowedLocalHttp) {
    throw unsafeEndpoint('Webhook endpoint must use HTTPS');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw unsafeEndpoint('Webhook endpoint must not contain credentials');
  }
  if (url.hash.length > 0) {
    throw unsafeEndpoint('Webhook endpoint must not contain a fragment');
  }
  if (url.search.length > 0) {
    throw unsafeEndpoint('Webhook endpoint must not contain query parameters');
  }

  const hostname = endpointHostname(url);
  if (hostname.length === 0) {
    throw unsafeEndpoint('Webhook endpoint must contain a hostname');
  }
  url.hostname = hostname;

  if (
    policy.allowInsecureLocalEndpoints !== true &&
    (isLocalHostname(hostname) || (isIP(hostname) !== 0 && !isPublicWebhookAddress(hostname)))
  ) {
    throw unsafeEndpoint('Webhook endpoint must use a public network address');
  }

  return url;
}

function endpointHostname(url: URL): string {
  const withoutIpv6Brackets =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  return withoutIpv6Brackets.toLowerCase().replace(/\.$/, '');
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  );
}

async function defaultDnsResolver(hostname: string): Promise<readonly WebhookResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((resolved) => {
    if (resolved.family !== 4 && resolved.family !== 6) {
      throw new Error('DNS resolver returned an unsupported address family');
    }
    return { address: resolved.address, family: resolved.family };
  });
}

async function resolveHostname(
  hostname: string,
  resolver: WebhookDnsResolver,
): Promise<readonly WebhookResolvedAddress[]> {
  try {
    return await resolver(hostname);
  } catch (error) {
    if (
      error instanceof PermanentWebhookDeliveryError ||
      error instanceof TransientWebhookDeliveryError
    ) {
      throw error;
    }
    throw new TransientWebhookDeliveryError(
      'REMOTE_UNAVAILABLE',
      'Webhook endpoint hostname could not be resolved',
      { cause: error },
    );
  }
}

function createBlockedIpv4Addresses(): BlockList {
  const addresses = new BlockList();
  const subnets: ReadonlyArray<readonly [string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [network, prefix] of subnets) {
    addresses.addSubnet(network, prefix, 'ipv4');
  }
  return addresses;
}

function createGloballyRoutableIpv6Addresses(): BlockList {
  const addresses = new BlockList();
  addresses.addSubnet('2000::', 3, 'ipv6');
  return addresses;
}

function createBlockedIpv6Addresses(): BlockList {
  const addresses = new BlockList();
  addresses.addSubnet('2001::', 23, 'ipv6');
  addresses.addSubnet('2001:db8::', 32, 'ipv6');
  addresses.addSubnet('2002::', 16, 'ipv6');
  addresses.addSubnet('3fff::', 20, 'ipv6');
  return addresses;
}

function unsafeEndpoint(message: string): PermanentWebhookDeliveryError {
  return new PermanentWebhookDeliveryError('UNSAFE_ENDPOINT', message);
}
