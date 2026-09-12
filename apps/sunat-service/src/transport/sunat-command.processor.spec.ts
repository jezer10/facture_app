import type { Job } from 'bullmq';

import {
  SUNAT_COMMAND_JOB,
  type SunatCommandEnvelope,
  type SunatResultEnvelope,
} from '@app/contracts';
import type { SunatCommandExecutor } from '@app/sunat';
import type { CompletedSunatCommand, SunatCommandLedgerPort } from '@app/sunat';

import type { BullMqSunatEventPublisher } from './bullmq-sunat-event-publisher';
import { SunatCommandProcessor } from './sunat-command.processor';

describe('SunatCommandProcessor', () => {
  it('publishes a completed result and its deterministic reconciliation follow-up', async () => {
    const output = { result: resultFixture(), followUp: reconcileFixture() };
    const execute = jest.fn().mockResolvedValue({ kind: 'completed', output });
    const publishResult = jest.fn().mockResolvedValue(undefined);
    const publishFollowUp = jest.fn().mockResolvedValue(undefined);
    const markDelivered = jest.fn().mockResolvedValue(undefined);
    const processor = new SunatCommandProcessor(
      { execute } as unknown as SunatCommandExecutor,
      { publishResult, publishFollowUp } as unknown as BullMqSunatEventPublisher,
      { markDelivered } as unknown as SunatCommandLedgerPort<CompletedSunatCommand>,
    );

    await processor.process(jobFixture());

    expect(execute).toHaveBeenCalledWith(commandFixture(), {
      attempt: 1,
      maxAttempts: 4,
      retryDelayMs: 5_000,
    });
    expect(publishResult).toHaveBeenCalledWith(output.result);
    expect(publishFollowUp).toHaveBeenCalledWith(output.followUp);
    expect(markDelivered).toHaveBeenCalledWith(commandFixture().eventId);
  });

  it('throws only the typed safe code when BullMQ should retry', async () => {
    const execute = jest.fn().mockResolvedValue({
      kind: 'retry',
      error: { code: 'SUNAT_PROVIDER_UNAVAILABLE' },
    });
    const publishResult = jest.fn();
    const markDelivered = jest.fn();
    const processor = new SunatCommandProcessor(
      { execute } as unknown as SunatCommandExecutor,
      {
        publishResult,
        publishFollowUp: jest.fn(),
      } as unknown as BullMqSunatEventPublisher,
      { markDelivered } as unknown as SunatCommandLedgerPort<CompletedSunatCommand>,
    );

    await expect(processor.process(jobFixture())).rejects.toThrow('SUNAT_PROVIDER_UNAVAILABLE');
    expect(publishResult).not.toHaveBeenCalled();
    expect(markDelivered).not.toHaveBeenCalled();
  });

  it('keeps the durable delivery pending when publishing fails', async () => {
    const output = { result: resultFixture() };
    const publishResult = jest.fn().mockRejectedValue(new Error('redis unavailable'));
    const markDelivered = jest.fn();
    const processor = new SunatCommandProcessor(
      {
        execute: jest.fn().mockResolvedValue({ kind: 'completed', output }),
      } as unknown as SunatCommandExecutor,
      {
        publishResult,
        publishFollowUp: jest.fn(),
      } as unknown as BullMqSunatEventPublisher,
      { markDelivered } as unknown as SunatCommandLedgerPort<CompletedSunatCommand>,
    );

    await expect(processor.process(jobFixture())).rejects.toThrow('redis unavailable');
    expect(markDelivered).not.toHaveBeenCalled();
  });

  it('never accepts an unrelated job name on the fiscal queue', async () => {
    const processor = new SunatCommandProcessor(
      { execute: jest.fn() } as unknown as SunatCommandExecutor,
      {
        publishResult: jest.fn(),
        publishFollowUp: jest.fn(),
      } as unknown as BullMqSunatEventPublisher,
      { markDelivered: jest.fn() } as unknown as SunatCommandLedgerPort<CompletedSunatCommand>,
    );

    await expect(processor.process(jobFixture({ name: 'unexpected-job' }))).rejects.toThrow(
      'SUNAT_UNKNOWN_JOB',
    );
  });
});

function commandFixture(): Extract<
  SunatCommandEnvelope,
  { type: 'sunat.document.issue.requested.v1' }
> {
  return {
    eventId: 'event-1',
    type: 'sunat.document.issue.requested.v1',
    version: 1,
    occurredAt: '2026-08-22T15:00:00.000Z',
    correlationId: 'correlation-1',
    organizationId: 'organization-1',
    issuerId: 'issuer-1',
    payloadRef: 'r2://core/document-1.json',
    payloadSha256: 'a'.repeat(64),
    payload: {
      documentId: 'document-1',
      documentType: '01',
      series: 'F001',
      number: '42',
    },
  };
}

function reconcileFixture(): Extract<
  SunatCommandEnvelope,
  { type: 'sunat.document.reconcile.requested.v1' }
> {
  return {
    ...commandFixture(),
    eventId: 'event-reconcile-1',
    type: 'sunat.document.reconcile.requested.v1',
    causationId: 'event-1',
    payload: {
      documentId: 'document-1',
      submissionId: 'submission-1',
    },
  };
}

function resultFixture(): Extract<SunatResultEnvelope, { type: 'sunat.document.reconciling.v1' }> {
  return {
    ...commandFixture(),
    eventId: 'result-1',
    type: 'sunat.document.reconciling.v1',
    causationId: 'event-1',
    payload: {
      documentId: 'document-1',
      submissionId: 'submission-1',
      nextCheckAt: '2026-08-22T15:00:30.000Z',
    },
  };
}

function jobFixture(overrides: Partial<Job<SunatCommandEnvelope>> = {}): Job<SunatCommandEnvelope> {
  return {
    name: SUNAT_COMMAND_JOB,
    data: commandFixture(),
    opts: { attempts: 4 },
    attemptsMade: 0,
    ...overrides,
  } as Job<SunatCommandEnvelope>;
}
