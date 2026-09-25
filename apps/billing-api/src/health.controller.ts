import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PublicRoute } from '@app/fiscal-core';
import { OBJECT_STORAGE_PORT, parseEnvironment } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';

@Controller('health')
@PublicRoute()
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  @Get('mode')
  mode(): { sunat: string; email: string; fiscalValidity: boolean } {
    const env = parseEnvironment(process.env);
    return { sunat: env.SUNAT_PROVIDER_MODE, email: env.BILLING_EMAIL_MODE, fiscalValidity: false };
  }

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
