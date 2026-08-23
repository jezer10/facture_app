import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { sunatDataSourceOptions } from './sunat.datasource';
import { SUNAT_ENTITIES } from './entities';

@Module({
  imports: [
    TypeOrmModule.forRoot(sunatDataSourceOptions),
    TypeOrmModule.forFeature([...SUNAT_ENTITIES]),
  ],
  exports: [TypeOrmModule],
})
export class SunatDatabaseModule {}
