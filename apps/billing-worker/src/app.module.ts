import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  CORE_ARTIFACTS_QUEUE,
  SUNAT_COMMANDS_QUEUE,
  SUNAT_RESULTS_QUEUE,
  WEBHOOKS_QUEUE,
} from '@app/contracts';
import { CoreDatabaseModule, PdfArtifactsWorkerModule, ReliabilityModule } from '@app/fiscal-core';
import { ObjectStorageModule, parseEnvironment, redisOptionsFromUrl } from '@app/platform';
import { WorkerHealthController } from './health.controller';

const environment = parseEnvironment(process.env);

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: parseEnvironment }),
    CoreDatabaseModule,
    BullModule.forRoot({
      connection: redisOptionsFromUrl(environment.REDIS_URL, environment.REDIS_PASSWORD_FILE),
      prefix: 'billing',
    }),
    BullModule.registerQueue(
      { name: SUNAT_COMMANDS_QUEUE },
      { name: SUNAT_RESULTS_QUEUE },
      { name: WEBHOOKS_QUEUE },
      { name: CORE_ARTIFACTS_QUEUE },
    ),
    ObjectStorageModule,
    ReliabilityModule,
    PdfArtifactsWorkerModule,
  ],
  controllers: [WorkerHealthController],
})
export class AppModule {}
