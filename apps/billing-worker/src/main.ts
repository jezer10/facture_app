import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseEnvironment } from '@app/platform';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const environment = parseEnvironment(process.env);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  await app.listen(environment.BILLING_WORKER_PORT, '0.0.0.0');
}

void bootstrap();
