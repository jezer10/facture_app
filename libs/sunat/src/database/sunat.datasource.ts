import 'reflect-metadata';

import { databaseUrlWithPassword, parseEnvironment } from '@app/platform';
import { DataSource } from 'typeorm';
import type { DataSourceOptions, LogLevel } from 'typeorm';

import { SUNAT_ENTITIES } from './entities';
import { CreateBillingSunat1787356800000 } from './migrations/202608220001-create-billing-sunat';
import { AddCommandDeliveryOutbox1787356860000 } from './migrations/202608220002-add-command-delivery-outbox';

const environment = parseEnvironment(process.env);
const developmentLogging: LogLevel[] = ['error', 'warn'];

export const sunatDataSourceOptions = {
  type: 'postgres' as const,
  url: databaseUrlWithPassword(
    environment.SUNAT_DATABASE_URL,
    environment.SUNAT_DATABASE_PASSWORD_FILE,
  ),
  entities: [...SUNAT_ENTITIES],
  migrations: [CreateBillingSunat1787356800000, AddCommandDeliveryOutbox1787356860000],
  migrationsTableName: 'typeorm_migrations',
  migrationsRun: false,
  synchronize: false,
  logging: environment.NODE_ENV === 'development' ? developmentLogging : false,
} satisfies DataSourceOptions;

export default new DataSource(sunatDataSourceOptions);
