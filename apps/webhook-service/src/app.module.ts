import {
  WEBHOOK_REPOSITORY,
  WEBHOOK_TRANSPORT,
  HttpWebhookTransport,
  InMemoryWebhookRepository,
  TypeOrmWebhookRepository,
  type WebhookRepository,
  type WebhookTransport,
  WebhookDeliveryService,
  WebhookSubscriptionConfigurationService,
} from '@app/webhooks';
import { WebhookDatabaseModule } from '@app/webhooks/database/webhook-database.module';
import { WEBHOOKS_QUEUE } from '@app/contracts';
import {
  parseEnvironment,
  EnvelopeEncryption,
  readSecretFile,
  redisOptionsFromUrl,
  type BillingEnvironment,
} from '@app/platform';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { BillingWebhooksProcessor } from './billing-webhooks.processor';
import { InternalHealthController } from './internal-health.controller';
import { InternalWebhookAuthGuard } from './internal-webhook-auth.guard';
import { InternalWebhookSubscriptionsController } from './internal-webhook-subscriptions.controller';
import {
  INTERNAL_WEBHOOK_API_CREDENTIAL,
  type InternalWebhookApiCredential,
  WEBHOOK_SERVICE_ENVIRONMENT,
} from './webhook-service.tokens';

const environment = parseEnvironment(process.env);
const usePersistentRepository =
  environment.NODE_ENV === 'production' || environment.ALLOW_VOLATILE_ADAPTERS !== true;
const repositoryProvider: Provider = usePersistentRepository
  ? {
      provide: WEBHOOK_REPOSITORY,
      useFactory: createPersistentWebhookRepository,
      inject: [DataSource, WEBHOOK_SERVICE_ENVIRONMENT],
    }
  : {
      provide: WEBHOOK_REPOSITORY,
      useFactory: createInMemoryWebhookRepository,
      inject: [WEBHOOK_SERVICE_ENVIRONMENT],
    };

@Module({
  imports: [
    BullModule.forRoot({
      prefix: 'billing',
      connection: redisOptionsFromUrl(environment.REDIS_URL, environment.REDIS_PASSWORD_FILE),
    }),
    BullModule.registerQueue({ name: WEBHOOKS_QUEUE }),
    ...(usePersistentRepository ? [WebhookDatabaseModule] : []),
  ],
  controllers: [InternalHealthController, InternalWebhookSubscriptionsController],
  providers: [
    BillingWebhooksProcessor,
    InternalWebhookAuthGuard,
    { provide: WEBHOOK_SERVICE_ENVIRONMENT, useValue: environment },
    {
      provide: INTERNAL_WEBHOOK_API_CREDENTIAL,
      useFactory: createInternalApiCredential,
      inject: [WEBHOOK_SERVICE_ENVIRONMENT],
    },
    repositoryProvider,
    {
      provide: WEBHOOK_TRANSPORT,
      useFactory: (values: BillingEnvironment): WebhookTransport =>
        new HttpWebhookTransport({
          allowInsecureLocalEndpoints: allowInsecureWebhookHttp(values),
        }),
      inject: [WEBHOOK_SERVICE_ENVIRONMENT],
    },
    {
      provide: WebhookDeliveryService,
      useFactory: (
        repository: WebhookRepository,
        transport: WebhookTransport,
        values: BillingEnvironment,
      ): WebhookDeliveryService =>
        new WebhookDeliveryService(repository, transport, {
          allowInsecureHttp: allowInsecureWebhookHttp(values),
          requestTimeoutMs: values.WEBHOOK_TIMEOUT_MS,
        }),
      inject: [WEBHOOK_REPOSITORY, WEBHOOK_TRANSPORT, WEBHOOK_SERVICE_ENVIRONMENT],
    },
    {
      provide: WebhookSubscriptionConfigurationService,
      useFactory: (
        repository: WebhookRepository,
        values: BillingEnvironment,
      ): WebhookSubscriptionConfigurationService =>
        new WebhookSubscriptionConfigurationService(repository, {
          allowInsecureHttp: allowInsecureWebhookHttp(values),
        }),
      inject: [WEBHOOK_REPOSITORY, WEBHOOK_SERVICE_ENVIRONMENT],
    },
  ],
})
export class AppModule {}

function createInMemoryWebhookRepository(values: BillingEnvironment): WebhookRepository {
  if (values.NODE_ENV === 'production' || values.ALLOW_VOLATILE_ADAPTERS !== true) {
    throw new Error(
      'The in-memory WebhookRepository must be explicitly enabled outside production',
    );
  }

  return InMemoryWebhookRepository.create({
    environment: values.NODE_ENV,
    explicitlyEnabled: true,
  });
}

function createPersistentWebhookRepository(
  dataSource: DataSource,
  values: BillingEnvironment,
): WebhookRepository {
  if (values.BILLING_MASTER_KEY_FILE === undefined) {
    throw new Error('BILLING_MASTER_KEY_FILE is required for durable webhook secret storage');
  }

  const loadedKey = readSecretFile(values.BILLING_MASTER_KEY_FILE, 32);
  const encryptionKey = Buffer.from(loadedKey);
  loadedKey.fill(0);
  return new TypeOrmWebhookRepository(dataSource, new EnvelopeEncryption(encryptionKey));
}

function createInternalApiCredential(values: BillingEnvironment): InternalWebhookApiCredential {
  if (values.WEBHOOK_INTERNAL_SERVICE_SECRET_FILE === undefined) {
    return {};
  }

  const secret = readSecretFile(values.WEBHOOK_INTERNAL_SERVICE_SECRET_FILE, 32);
  try {
    return { bearerToken: secret.toString('base64url') };
  } finally {
    secret.fill(0);
  }
}

function allowInsecureWebhookHttp(values: BillingEnvironment): boolean {
  return values.NODE_ENV !== 'production' && process.env.WEBHOOK_ALLOW_INSECURE_HTTP === 'true';
}
