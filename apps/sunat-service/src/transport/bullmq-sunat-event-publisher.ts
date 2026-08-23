import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  SUNAT_COMMAND_JOB,
  SUNAT_COMMANDS_QUEUE,
  SUNAT_RESULT_JOB,
  SUNAT_RESULTS_QUEUE,
  type SunatCommandEnvelope,
  type SunatResultEnvelope,
} from '@app/contracts';

import {
  commandBackoffMs,
  reconciliationAttempts,
  reconciliationDelayMs,
  resultAttempts,
  resultBackoffMs,
} from '../runtime-config';

@Injectable()
export class BullMqSunatEventPublisher {
  constructor(
    @InjectQueue(SUNAT_RESULTS_QUEUE)
    private readonly resultQueue: Queue<SunatResultEnvelope>,
    @InjectQueue(SUNAT_COMMANDS_QUEUE)
    private readonly commandQueue: Queue<SunatCommandEnvelope>,
  ) {}

  async publishResult(result: SunatResultEnvelope): Promise<void> {
    await this.resultQueue.add(SUNAT_RESULT_JOB, result, {
      jobId: result.eventId,
      attempts: resultAttempts(),
      backoff: { type: 'exponential', delay: resultBackoffMs() },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100_000 },
      removeOnFail: false,
    });
  }

  async publishFollowUp(command: SunatCommandEnvelope): Promise<void> {
    await this.commandQueue.add(SUNAT_COMMAND_JOB, command, {
      jobId: command.eventId,
      delay: reconciliationDelayMs(),
      attempts: reconciliationAttempts(),
      backoff: { type: 'exponential', delay: commandBackoffMs() },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100_000 },
      removeOnFail: false,
    });
  }
}
