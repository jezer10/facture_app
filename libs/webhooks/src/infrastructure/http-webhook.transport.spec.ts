import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpWebhookTransport } from './http-webhook.transport';

describe('HttpWebhookTransport', () => {
  it('connects to the verified address while preserving the original Host header', async () => {
    let resolveReceived: (value: ReceivedRequest) => void = () => undefined;
    const received = new Promise<ReceivedRequest>((resolve) => {
      resolveReceived = resolve;
    });
    const server = createServer((request, response) => {
      void readRequest(request).then((body) => {
        resolveReceived({ body, host: request.headers.host });
        response.writeHead(204).end();
      });
    });
    await listenOnLoopback(server);
    const { port } = server.address() as AddressInfo;

    try {
      const transport = new HttpWebhookTransport({
        allowInsecureLocalEndpoints: true,
        resolveHostname: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      });

      await expect(
        transport.post({
          body: '{"eventId":"evt_123"}',
          headers: { 'content-type': 'application/json' },
          timeoutMs: 1_000,
          url: `http://receiver.example:${port}/hooks`,
        }),
      ).resolves.toEqual({ statusCode: 204 });
      await expect(received).resolves.toEqual({
        body: '{"eventId":"evt_123"}',
        host: `receiver.example:${port}`,
      });
    } finally {
      await closeServer(server);
    }
  });

  it('fails permanently before connecting when DNS resolves to a private address', async () => {
    const transport = new HttpWebhookTransport({
      resolveHostname: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });

    await expect(
      transport.post({
        body: '{}',
        headers: {},
        timeoutMs: 1_000,
        url: 'https://receiver.example/hooks',
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_ENDPOINT', retryable: false });
  });

  it('applies the request deadline while DNS resolution is pending', async () => {
    const transport = new HttpWebhookTransport({
      resolveHostname: () => new Promise(() => undefined),
    });

    await expect(
      transport.post({
        body: '{}',
        headers: {},
        timeoutMs: 10,
        url: 'https://receiver.example/hooks',
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_TIMEOUT', retryable: true });
  });

  it('closes the socket after receiving status headers when the response body never ends', async () => {
    let resolveSocketClosed: () => void = () => undefined;
    const socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once('close', resolveSocketClosed);
      response.writeHead(202, { 'content-type': 'text/plain' });
      response.write('partial response');
    });
    await listenOnLoopback(server);
    const { port } = server.address() as AddressInfo;

    try {
      const transport = new HttpWebhookTransport({
        allowInsecureLocalEndpoints: true,
        resolveHostname: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      });

      await expect(
        transport.post({
          body: '{}',
          headers: { 'content-type': 'application/json' },
          timeoutMs: 1_000,
          url: `http://receiver.example:${port}/hooks`,
        }),
      ).resolves.toEqual({ statusCode: 202 });
      await expect(resolvesWithin(socketClosed, 500)).resolves.toBe(true);
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });
});

interface ReceivedRequest {
  readonly body: string;
  readonly host: string | undefined;
}

function readRequest(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function resolvesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}
