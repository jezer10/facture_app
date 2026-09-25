import { InjectTaskQueue } from '@app/platform';
import { Injectable } from '@nestjs/common';
import type { TaskQueue } from '@app/platform';

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
export class SqsSunatEventPublisher {
  constructor(
    @InjectTaskQueue(SUNAT_RESULTS_QUEUE)
    private readonly resultQueue: TaskQueue<SunatResultEnvelope>,
    @InjectTaskQueue(SUNAT_COMMANDS_QUEUE)
    private readonly commandQueue: TaskQueue<SunatCommandEnvelope>,
  ) {}

  async publishResult(result: SunatResultEnvelope): Promise<void> {
    await this.resultQueue.add(SUNAT_RESULT_JOB, result, {
      jobId: result.eventId,
      attempts: resultAttempts(),
      backoff: { type: 'exponential', delay: resultBackoffMs() },
    });
  }

  async publishFollowUp(command: SunatCommandEnvelope): Promise<void> {
    await this.commandQueue.add(SUNAT_COMMAND_JOB, command, {
      jobId: command.eventId,
      delay: reconciliationDelayMs(),
      attempts: reconciliationAttempts(),
      backoff: { type: 'exponential', delay: commandBackoffMs() },
    });
  }
}
