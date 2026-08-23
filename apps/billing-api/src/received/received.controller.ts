import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentPrincipal, ReceivedDocumentsService, RequireScopes } from '@app/fiscal-core';
import type {
  AuthenticatedRequest,
  BillingPrincipal,
  ReceivedDocumentEntity,
  ReceivedSyncView,
} from '@app/fiscal-core';
import { ListReceivedDocumentsQuery, RequestReceivedSyncDto } from './received.dto';

@Controller()
export class ReceivedController {
  constructor(private readonly receivedDocuments: ReceivedDocumentsService) {}

  @Post('received-document-syncs')
  @HttpCode(202)
  @RequireScopes('received:sync')
  requestSync(
    @Body() body: RequestReceivedSyncDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: BillingPrincipal,
    @Req() request: Request,
  ): Promise<ReceivedSyncView> {
    return this.receivedDocuments.requestSync(
      principal,
      { ...body, idempotencyKey: idempotencyKey ?? '' },
      (request as AuthenticatedRequest).correlationId,
    );
  }

  @Get('received-document-syncs/:syncId')
  @RequireScopes('received:read')
  getSync(
    @Param('syncId') syncId: string,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<ReceivedSyncView> {
    return this.receivedDocuments.getSync(principal, syncId);
  }

  @Get('received-documents/:documentId')
  @RequireScopes('received:read')
  getReceivedDocument(
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<ReceivedDocumentEntity> {
    return this.receivedDocuments.getReceivedDocument(principal, documentId);
  }

  @Get('received-documents')
  @RequireScopes('received:read')
  list(
    @Query() query: ListReceivedDocumentsQuery,
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<ReceivedDocumentEntity[]> {
    return this.receivedDocuments.list(principal, query.limit, query.offset);
  }
}
