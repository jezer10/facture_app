import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { type SunatReadinessReport, SunatHealthService } from './sunat-health.service';

@Controller('internal/health')
export class SunatHealthController {
  constructor(private readonly health: SunatHealthService) {}

  @Get('live')
  liveness(): { status: 'ok'; service: 'sunat-service' } {
    return { status: 'ok', service: 'sunat-service' as const };
  }

  @Get('ready')
  async readiness(): Promise<SunatReadinessReport> {
    const report = await this.health.readiness();
    if (report.status !== 'ready') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
