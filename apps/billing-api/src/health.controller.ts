import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PublicRoute } from '@app/fiscal-core';
import { OBJECT_STORAGE_PORT } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';

@Controller('health')
@PublicRoute()
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ready' }> {
    try {
      await Promise.all([this.dataSource.query('SELECT 1'), this.storage.healthCheck()]);
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('A required dependency is unavailable');
    }
  }
}
