import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  SUNAT_COMMAND_LEDGER_PORT,
  type CompletedSunatCommand,
  type PendingCommandDelivery,
  type SunatCommandLedgerPort,
} from '@app/sunat';
import { BullMqSunatEventPublisher } from './bullmq-sunat-event-publisher';

const CLAIM_LIMIT = 20;
const DELIVERY_LEASE_MS = 60_000;

@Injectable()
export class SunatResultOutboxRelay {
  private readonly logger = new Logger(SunatResultOutboxRelay.name);
  private publishing = false;

  constructor(
    @Inject(SUNAT_COMMAND_LEDGER_PORT)
    private readonly ledger: SunatCommandLedgerPort<CompletedSunatCommand>,
    private readonly publisher: BullMqSunatEventPublisher,
  ) {}

  @Interval(1_000)
  async publishPendingDeliveries(): Promise<void> {
    if (this.publishing) {
      return;
    }
    this.publishing = true;
    try {
      const deliveries = await this.ledger.claimPendingDeliveries(CLAIM_LIMIT, DELIVERY_LEASE_MS);
      for (const delivery of deliveries) {
        await this.publishOne(delivery);
      }
    } finally {
      this.publishing = false;
    }
  }

  private async publishOne(delivery: PendingCommandDelivery<CompletedSunatCommand>): Promise<void> {
    try {
      await this.publisher.publishResult(delivery.result.result);
      if (delivery.result.followUp) {
        await this.publisher.publishFollowUp(delivery.result.followUp);
      }
      await this.ledger.markDelivered(delivery.eventId);
    } catch {
      await this.ledger.rescheduleDelivery(
        delivery.eventId,
        'SUNAT_RESULT_PUBLISH_FAILED',
        new Date(Date.now() + deliveryBackoffMilliseconds(delivery.attempt)),
      );
      this.logger.error(
        JSON.stringify({
          code: 'SUNAT_RESULT_PUBLISH_FAILED',
          commandEventId: delivery.eventId,
          attempt: delivery.attempt,
        }),
      );
    }
  }
}

function deliveryBackoffMilliseconds(attempt: number): number {
  return Math.min(5 * 60_000, 2 ** Math.min(attempt, 10) * 1_000);
}
