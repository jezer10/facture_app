import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { coreDataSourceOptions } from './core.datasource';
import { CORE_ENTITIES } from './entities';

@Module({
  imports: [
    TypeOrmModule.forRoot(coreDataSourceOptions),
    TypeOrmModule.forFeature([...CORE_ENTITIES]),
  ],
  exports: [TypeOrmModule],
})
export class CoreDatabaseModule {}
