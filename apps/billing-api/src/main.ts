import 'reflect-metadata';
import helmet from 'helmet';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { parseEnvironment } from '@app/platform';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const environment = parseEnvironment(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  if (environment.BILLING_TRUSTED_PROXY_CIDRS) {
    app.set(
      'trust proxy',
      environment.BILLING_TRUSTED_PROXY_CIDRS.split(',').map((cidr) => cidr.trim()),
    );
  }
  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      stopAtFirstError: false,
    }),
  );
  app.enableShutdownHooks();

  if (environment.NODE_ENV !== 'production') {
    const swagger = new DocumentBuilder()
      .setTitle('Facture App Billing API')
      .setVersion('1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'Authorization', in: 'header' }, 'api-key')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));
  }

  await app.listen(environment.BILLING_API_PORT, '0.0.0.0');
}

void bootstrap();
