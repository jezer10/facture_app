import { SqsQueueModule } from '@app/platform';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  CORE_ARTIFACTS_QUEUE,
  SUNAT_COMMANDS_QUEUE,
  SUNAT_RESULTS_QUEUE,
  WEBHOOKS_QUEUE,
} from '@app/contracts';
import { CoreDatabaseModule, PdfArtifactsWorkerModule, ReliabilityModule } from '@app/fiscal-core';
import { ObjectStorageModule, parseEnvironment } from '@app/platform';
import { WorkerHealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: parseEnvironment }),
    CoreDatabaseModule,
    SqsQueueModule.forRoot(),
    SqsQueueModule.registerQueue(
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
