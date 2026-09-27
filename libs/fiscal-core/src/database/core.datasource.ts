import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { databaseUrlWithPassword, parseEnvironment } from '@app/platform';
import { CORE_ENTITIES } from './entities';
import { CreateBillingCore1787356800000 } from './migrations/202608220001-create-billing-core';
import { AddCoreOutboxRetrying1787356860000 } from './migrations/202608220002-add-core-outbox-retrying';
import { AddReceivedSyncIdempotency1787356920000 } from './migrations/202608220003-add-received-sync-idempotency';
import { EnforceCoreTenantIsolation1787356980000 } from './migrations/202608220004-enforce-core-tenant-isolation';
import { AddApiKeyCreationIdempotency1787357040000 } from './migrations/202608220005-add-api-key-creation-idempotency';
import { AddDocumentEmail1790208000000 } from './migrations/202609240001-add-document-email';

import { AddBrowserAuth1790294400000 } from './migrations/202609250001-add-browser-auth';

import { AddBrowserAccessInvites1790294460000 } from './migrations/202609250002-add-browser-access-invites';

import { AddCompanyRegistrations1790294520000 } from './migrations/202609250003-add-company-registrations';

import { AddNativeLoginChallenges1790294580000 } from './migrations/202609250004-add-native-login-challenges';

import { AddBrowserIdentityTokens1790380800000 } from './migrations/202609260001-add-browser-identity-tokens';

import { CompanyEnvironments1790467200000 } from './migrations/202609270001-company-environments';

const environment = parseEnvironment(process.env);

export const coreDataSourceOptions = {
  type: 'postgres' as const,
  url: databaseUrlWithPassword(
    environment.CORE_DATABASE_URL,
    environment.CORE_DATABASE_PASSWORD_FILE,
  ),
  entities: [...CORE_ENTITIES],
  migrations: [
    CreateBillingCore1787356800000,
    AddCoreOutboxRetrying1787356860000,
    AddReceivedSyncIdempotency1787356920000,
    EnforceCoreTenantIsolation1787356980000,
    AddApiKeyCreationIdempotency1787357040000,
    AddDocumentEmail1790208000000,
    AddBrowserAuth1790294400000,
    AddBrowserAccessInvites1790294460000,
    AddCompanyRegistrations1790294520000,
    AddNativeLoginChallenges1790294580000,
    AddBrowserIdentityTokens1790380800000,
    CompanyEnvironments1790467200000,
  ],
  migrationsTableName: 'typeorm_migrations',
  migrationsRun: false,
  synchronize: false,
  logging: environment.NODE_ENV === 'development' ? ['error', 'warn'] : false,
} satisfies DataSourceOptions;

export default new DataSource(coreDataSourceOptions);
