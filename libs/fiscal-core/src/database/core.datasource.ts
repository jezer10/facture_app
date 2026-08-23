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
  ],
  migrationsTableName: 'typeorm_migrations',
  migrationsRun: false,
  synchronize: false,
  logging: environment.NODE_ENV === 'development' ? ['error', 'warn'] : false,
} satisfies DataSourceOptions;

export default new DataSource(coreDataSourceOptions);
