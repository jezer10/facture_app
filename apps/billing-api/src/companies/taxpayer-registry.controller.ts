import { Controller, Get, Header, Param, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  PublicRoute,
  BrowserSessionService,
  TaxpayerRegistryService,
  type TaxpayerLookup,
} from '@app/fiscal-core';
@Controller('taxpayer-registry')
@PublicRoute()
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class TaxpayerRegistryController {
  constructor(
    private readonly sessions: BrowserSessionService,
    private readonly registry: TaxpayerRegistryService,
  ) {}
  @Get(':ruc')
  @Header('Cache-Control', 'no-store')
  async lookup(@Req() request: Request, @Param('ruc') ruc: string): Promise<TaxpayerLookup> {
    await this.sessions.identity(request);
    return this.registry.lookup(ruc);
  }
}
