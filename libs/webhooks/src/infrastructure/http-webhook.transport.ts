import { request as requestHttp, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as requestHttps, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';

import { resolveWebhookEndpoint, type WebhookDnsResolver } from '../domain/webhook-endpoint';
import type {
  WebhookTransport,
  WebhookTransportRequest,
  WebhookTransportResponse,
} from '../domain/webhook-transport';
import {
  isWebhookDeliveryError,
  PermanentWebhookDeliveryError,
  TransientWebhookDeliveryError,
} from '../domain/webhook.errors';

export interface HttpWebhookTransportOptions {
  readonly allowInsecureLocalEndpoints?: boolean;
  readonly resolveHostname?: WebhookDnsResolver;
}

export class HttpWebhookTransport implements WebhookTransport {
  constructor(private readonly options: HttpWebhookTransportOptions = {}) {}

  async post(request: WebhookTransportRequest): Promise<WebhookTransportResponse> {
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new PermanentWebhookDeliveryError(
        'INVALID_SUBSCRIPTION',
        'Webhook request timeout must be a positive integer',
      );
    }

    const abortController = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timeoutResult = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('Webhook request deadline exceeded');
        abortController.abort(error);
        reject(error);
      }, request.timeoutMs);
    });

    try {
      return await Promise.race([
        this.postToResolvedEndpoint(request, abortController.signal),
        timeoutResult,
      ]);
    } catch (error) {
      if (isWebhookDeliveryError(error)) {
        throw error;
      }
      if (abortController.signal.aborted) {
        throw new TransientWebhookDeliveryError('REMOTE_TIMEOUT', 'Webhook request timed out', {
          cause: error,
        });
      }
      throw new TransientWebhookDeliveryError(
        'REMOTE_UNAVAILABLE',
        'Webhook endpoint is temporarily unavailable',
        { cause: error },
      );
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private async postToResolvedEndpoint(
    request: WebhookTransportRequest,
    signal: AbortSignal,
  ): Promise<WebhookTransportResponse> {
    const endpoint = await resolveWebhookEndpoint(request.url, {
      allowInsecureLocalEndpoints: this.options.allowInsecureLocalEndpoints,
      ...(this.options.resolveHostname === undefined
        ? {}
        : { resolveHostname: this.options.resolveHostname }),
    });
    if (signal.aborted) {
      throw signal.reason;
    }

    return sendPinnedRequest(request, endpoint, signal);
  }
}

function sendPinnedRequest(
  request: WebhookTransportRequest,
  endpoint: Awaited<ReturnType<typeof resolveWebhookEndpoint>>,
  signal: AbortSignal,
): Promise<WebhookTransportResponse> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      family: endpoint.family,
      headers: {
        ...request.headers,
        'content-length': String(Buffer.byteLength(request.body, 'utf8')),
        host: endpoint.url.host,
      },
      hostname: endpoint.address,
      method: 'POST',
      path: `${endpoint.url.pathname}${endpoint.url.search}`,
      port: endpoint.url.port.length === 0 ? undefined : Number(endpoint.url.port),
      protocol: endpoint.url.protocol,
      signal,
      ...(endpoint.url.protocol === 'https:' && isIP(endpoint.hostname) === 0
        ? { servername: endpoint.hostname }
        : {}),
    };

    let outbound: ClientRequest;
    try {
      outbound =
        endpoint.url.protocol === 'https:'
          ? requestHttps(options, handleResponse)
          : requestHttp(options, handleResponse);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Webhook request could not be created'));
      return;
    }

    outbound.once('error', reject);
    outbound.end(request.body, 'utf8');

    function handleResponse(response: IncomingMessage): void {
      const { statusCode } = response;
      response.destroy();

      if (statusCode === undefined) {
        reject(new Error('Webhook endpoint returned no HTTP status'));
        return;
      }
      resolve({ statusCode });
    }
  });
}
