import { SqsQueueModule } from '@app/platform';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { SUNAT_COMMANDS_QUEUE, SUNAT_RESULTS_QUEUE } from '@app/contracts';
import { SunatModule } from '@app/sunat';

import { SunatHealthController } from './health/sunat-health.controller';
import { SunatHealthService } from './health/sunat-health.service';
import { sunatMockAllowAnyIssuer, sunatMockIssuerIds, sunatProviderMode } from './runtime-config';
import { SqsSunatEventPublisher } from './transport/sqs-sunat-event-publisher';
import { SunatCommandProcessor } from './transport/sunat-command.processor';
import { SunatResultOutboxRelay } from './transport/sunat-result-outbox-relay';

const sunatDomainModule =
  sunatProviderMode() === 'mock'
    ? SunatModule.forDurableMock({
        allowAnyIssuer: sunatMockAllowAnyIssuer(),
        issuerIds: sunatMockIssuerIds(),
      })
    : sunatProviderMode() === 'beta'
      ? SunatModule.forBeta()
      : SunatModule.forProduction();

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    ScheduleModule.forRoot(),
    SqsQueueModule.forRoot(),
    SqsQueueModule.registerQueue({ name: SUNAT_COMMANDS_QUEUE }, { name: SUNAT_RESULTS_QUEUE }),
    sunatDomainModule,
  ],
  controllers: [SunatHealthController],
  providers: [
    SunatHealthService,
    SqsSunatEventPublisher,
    SunatCommandProcessor,
    SunatResultOutboxRelay,
  ],
})
export class AppModule {}
