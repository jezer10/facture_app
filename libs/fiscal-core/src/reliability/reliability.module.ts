import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import {
  CORE_ARTIFACTS_QUEUE,
  SUNAT_COMMANDS_QUEUE,
  SUNAT_RESULTS_QUEUE,
  WEBHOOKS_QUEUE,
} from '@app/contracts';
import { ObjectStorageModule } from '@app/platform';
import { OutboxPublisherService } from './outbox-publisher.service';
import { SunatResultsProcessor } from './sunat-results.processor';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ObjectStorageModule,
    BullModule.registerQueue(
      { name: SUNAT_COMMANDS_QUEUE },
      { name: SUNAT_RESULTS_QUEUE },
      { name: WEBHOOKS_QUEUE },
      { name: CORE_ARTIFACTS_QUEUE },
    ),
  ],
  providers: [OutboxPublisherService, SunatResultsProcessor],
})
export class ReliabilityModule {}
