import { DeferredTaskError } from '@app/platform';
import { QueueProcessor, TaskWorker } from '@app/platform';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TaskJob, NonRetryableJobError } from '@app/platform';

import { SUNAT_COMMAND_JOB, SUNAT_COMMANDS_QUEUE, type SunatCommandEnvelope } from '@app/contracts';
import {
  SUNAT_COMMAND_LEDGER_PORT,
  SunatCommandExecutor,
  type CompletedSunatCommand,
  type SunatCommandLedgerPort,
} from '@app/sunat';

import { commandBackoffMs } from '../runtime-config';
import { SqsSunatEventPublisher } from './sqs-sunat-event-publisher';

@Injectable()
@QueueProcessor(SUNAT_COMMANDS_QUEUE, { concurrency: 4 })
export class SunatCommandProcessor extends TaskWorker {
  private readonly logger = new Logger(SunatCommandProcessor.name);

  constructor(
    private readonly executor: SunatCommandExecutor,
    private readonly publisher: SqsSunatEventPublisher,
    @Inject(SUNAT_COMMAND_LEDGER_PORT)
    private readonly ledger: SunatCommandLedgerPort<CompletedSunatCommand>,
  ) {
    super();
  }

  async process(job: TaskJob<SunatCommandEnvelope>): Promise<void> {
    if (job.name !== SUNAT_COMMAND_JOB) {
      throw new NonRetryableJobError('SUNAT_UNKNOWN_JOB');
    }

    const maxAttempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;
    const decision = await this.executor.execute(job.data, {
      attempt,
      maxAttempts,
      retryDelayMs: exponentialDelay(attempt),
    });

    if (decision.kind === 'retry') {
      if (decision.error.code === 'SUNAT_COMMAND_ALREADY_PROCESSING')
        throw new DeferredTaskError(300);
      this.logger.warn(
        safeLog('retry', job.data, {
          code: decision.error.code,
          attempt,
          maxAttempts,
        }),
      );
      throw new Error(decision.error.code);
    }

    await this.publisher.publishResult(decision.output.result);
    if (decision.output.followUp) {
      await this.publisher.publishFollowUp(decision.output.followUp);
    }
    await this.ledger.markDelivered(job.data.eventId);
    this.logger.log(
      safeLog('completed', job.data, {
        resultType: decision.output.result.type,
      }),
    );
  }
}

function exponentialDelay(attempt: number): number {
  return Math.min(commandBackoffMs() * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
}

function safeLog(
  action: 'retry' | 'completed',
  command: SunatCommandEnvelope,
  metadata: Readonly<Record<string, string | number>>,
): string {
  return JSON.stringify({
    action,
    eventId: command.eventId,
    commandType: command.type,
    correlationId: command.correlationId,
    organizationId: command.organizationId,
    issuerId: command.issuerId,
    ...metadata,
  });
}
