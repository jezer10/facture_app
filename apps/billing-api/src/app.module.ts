import { WorkspaceController } from './companies/workspace.controller';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import {
  AdministrationModule,
  AuthModule,
  CoreDatabaseModule,
  DocumentsModule,
  ArtifactsModule,
  ReceivedModule,
  RecipientQueryModule,
} from '@app/fiscal-core';
import { ObjectStorageModule, environmentSchema } from '@app/platform';
import { AdminController } from './admin/admin.controller';
import { AdministrativeIntegrationsController } from './admin/administrative-integrations.controller';
import { InternalBillingServicesClient } from './admin/internal-billing-services.client';
import { HealthController } from './health.controller';
import { FiscalDocumentsController } from './documents/fiscal-documents.controller';
import { ReceivedController } from './received/received.controller';
import { RecipientQueryController } from './recipient/recipient-query.controller';

import { CompanyRegistrationService, TaxpayerRegistryService } from '@app/fiscal-core';
import {
  CompanyRegistrationController,
  CompanyReviewController,
} from './companies/company-registration.controller';

import { TaxpayerRegistryController } from './companies/taxpayer-registry.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validationSchema: environmentSchema,
    }),
    CoreDatabaseModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    ObjectStorageModule,
    AuthModule,
    AdministrationModule,
    DocumentsModule,
    ArtifactsModule,
    ReceivedModule,
    RecipientQueryModule,
  ],
  controllers: [
    WorkspaceController,
    TaxpayerRegistryController,
    CompanyRegistrationController,
    CompanyReviewController,
    AdminController,
    AdministrativeIntegrationsController,
    FiscalDocumentsController,
    HealthController,
    ReceivedController,
    RecipientQueryController,
  ],
  providers: [
    TaxpayerRegistryService,
    CompanyRegistrationService,
    InternalBillingServicesClient,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
