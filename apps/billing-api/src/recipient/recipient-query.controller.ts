import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicRoute, RecipientQueryService } from '@app/fiscal-core';
import type { RecipientQueryResult } from '@app/fiscal-core';
import { RecipientQueryDto } from './recipient-query.dto';

@Controller('recipient-queries')
export class RecipientQueryController {
  constructor(private readonly recipientQueries: RecipientQueryService) {}

  @Post()
  @PublicRoute()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  query(@Body() proof: RecipientQueryDto): Promise<RecipientQueryResult> {
    return this.recipientQueries.query(proof);
  }
}
