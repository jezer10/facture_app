import 'reflect-metadata';

import { databaseUrlWithPassword, parseEnvironment } from '@app/platform';
import { DataSource, type DataSourceOptions } from 'typeorm';

import { WEBHOOK_ENTITIES } from './entities';
import { CreateBillingDelivery1787356800000 } from './migrations/202608220001-create-billing-delivery';

const environment = parseEnvironment(process.env);

export const webhooksDataSourceOptions = {
  type: 'postgres' as const,
  url: databaseUrlWithPassword(
    environment.WEBHOOK_DATABASE_URL,
    environment.WEBHOOK_DATABASE_PASSWORD_FILE,
  ),
  entities: [...WEBHOOK_ENTITIES],
  migrations: [CreateBillingDelivery1787356800000],
  migrationsTableName: 'typeorm_migrations',
  migrationsRun: false,
  synchronize: false,
  logging: environment.NODE_ENV === 'development' ? ['error', 'warn'] : false,
} satisfies DataSourceOptions;

export default new DataSource(webhooksDataSourceOptions);
