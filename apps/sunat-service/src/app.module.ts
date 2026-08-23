import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { SUNAT_COMMANDS_QUEUE, SUNAT_RESULTS_QUEUE } from '@app/contracts';
import { SunatModule } from '@app/sunat';

import { SunatHealthController } from './health/sunat-health.controller';
import { SunatHealthService } from './health/sunat-health.service';
import {
  commandAttempts,
  commandBackoffMs,
  redisConnectionConfig,
  sunatMockAllowAnyIssuer,
  sunatMockIssuerIds,
  sunatProviderMode,
} from './runtime-config';
import { BullMqSunatEventPublisher } from './transport/bullmq-sunat-event-publisher';
import { SunatCommandProcessor } from './transport/sunat-command.processor';
import { SunatResultOutboxRelay } from './transport/sunat-result-outbox-relay';

const sunatDomainModule =
  sunatProviderMode() === 'mock'
    ? SunatModule.forDurableMock({
        allowAnyIssuer: sunatMockAllowAnyIssuer(),
        issuerIds: sunatMockIssuerIds(),
      })
    : SunatModule.forProduction();

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: redisConnectionConfig(),
      prefix: 'billing',
    }),
    BullModule.registerQueue(
      {
        name: SUNAT_COMMANDS_QUEUE,
        defaultJobOptions: {
          attempts: commandAttempts(),
          backoff: { type: 'exponential', delay: commandBackoffMs() },
          removeOnComplete: { count: 5_000 },
          removeOnFail: { count: 5_000 },
        },
      },
      { name: SUNAT_RESULTS_QUEUE },
    ),
    sunatDomainModule,
  ],
  controllers: [SunatHealthController],
  providers: [
    SunatHealthService,
    BullMqSunatEventPublisher,
    SunatCommandProcessor,
    SunatResultOutboxRelay,
  ],
})
export class AppModule {}
