import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { InjectTaskQueue } from '@app/platform';
import { InjectDataSource } from '@nestjs/typeorm';
import type { TaskQueue } from '@app/platform';
import { DataSource } from 'typeorm';
import { CORE_ARTIFACTS_QUEUE, SUNAT_COMMANDS_QUEUE, SUNAT_RESULTS_QUEUE } from '@app/contracts';
import { PdfRendererService } from '@app/fiscal-core';
import { OBJECT_STORAGE_PORT } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';

@Controller('internal/health')
export class WorkerHealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectTaskQueue(SUNAT_COMMANDS_QUEUE) private readonly commands: TaskQueue,
    @InjectTaskQueue(SUNAT_RESULTS_QUEUE) private readonly results: TaskQueue,
    @InjectTaskQueue(CORE_ARTIFACTS_QUEUE) private readonly artifacts: TaskQueue,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
    private readonly pdfRenderer: PdfRendererService,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ready' }> {
    try {
      await Promise.all([
        this.dataSource.query('SELECT 1'),
        this.commands.healthCheck(),
        this.results.healthCheck(),
        this.artifacts.healthCheck(),
        this.storage.healthCheck(),
        this.pdfRenderer.healthCheck(),
      ]);
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('A required worker dependency is unavailable');
    }
  }
}
