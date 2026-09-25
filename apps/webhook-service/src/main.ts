import 'reflect-metadata';

import type { BillingEnvironment } from '@app/platform';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { WEBHOOK_SERVICE_ENVIRONMENT } from './webhook-service.tokens';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const environment = app.get<BillingEnvironment>(WEBHOOK_SERVICE_ENVIRONMENT);

  app.use(helmet());
  app.enableShutdownHooks();

  await app.listen(environment.WEBHOOK_SERVICE_PORT, '0.0.0.0');
}

void bootstrap();
