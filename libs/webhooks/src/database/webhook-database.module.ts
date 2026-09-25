import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { webhooksDataSourceOptions } from './webhooks.datasource';

@Module({
  imports: [TypeOrmModule.forRoot(webhooksDataSourceOptions)],
  exports: [TypeOrmModule],
})
export class WebhookDatabaseModule {}
