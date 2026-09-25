import type { TaskQueue } from '@app/platform';

import type {
  IssuerCredentialPort,
  SunatArtifactStorePort,
  SunatCommandLedgerPort,
  SunatPayloadStorePort,
  SunatProviderPort,
  SunatSubmissionJournalPort,
  XmlSignerPort,
} from '@app/sunat';

import { SunatHealthService } from './sunat-health.service';

describe('SunatHealthService', () => {
  it('reports an explicit non-production mock readiness state', async () => {
    const service = healthService();

    const report = await service.readiness();

    expect(report.status).toBe('ready');
    expect(report.productionCapable).toBe(false);
    expect(report.checks.signer?.detail).toContain('no firmado');
  });

  it('becomes unready instead of falling back when SQS is unavailable', async () => {
    const unavailableQueue = {
      healthCheck: jest.fn().mockRejectedValue(new Error('sqs unavailable')),
    } as unknown as TaskQueue;
    const service = healthService(unavailableQueue);

    const report = await service.readiness();

    expect(report.status).toBe('not_ready');
    expect(report.checks.queues).toEqual({
      ready: false,
      detail: 'Amazon SQS no está disponible.',
    });
  });
});

function healthService(queue: TaskQueue = readyQueue()): SunatHealthService {
  const provider = {
    health: jest.fn().mockResolvedValue({
      ready: true,
      provider: 'mock',
      environment: 'mock',
      detail: 'mock',
    }),
  } as unknown as SunatProviderPort;
  const signer = {
    readiness: () => ({
      ready: true,
      mode: 'mock_unsigned' as const,
      detail: 'XML no firmado; sólo mock.',
    }),
  } as XmlSignerPort;
  const volatileReadiness = {
    readiness: jest.fn().mockResolvedValue({
      ready: true,
      durable: false,
      detail: 'volátil',
    }),
  };
  return new SunatHealthService(
    provider,
    signer,
    volatileReadiness as unknown as IssuerCredentialPort,
    volatileReadiness as unknown as SunatPayloadStorePort,
    volatileReadiness as unknown as SunatArtifactStorePort,
    volatileReadiness as unknown as SunatCommandLedgerPort,
    volatileReadiness as unknown as SunatSubmissionJournalPort,
    queue,
    queue,
  );
}

function readyQueue(): TaskQueue {
  return {
    healthCheck: jest.fn().mockResolvedValue({ waiting: 0 }),
  } as unknown as TaskQueue;
}
