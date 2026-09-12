import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AcceptedFiscalDocument, ArtifactReference } from '@app/contracts';
import {
  CurrentPrincipal,
  DocumentArtifactsService,
  FiscalDocumentsService,
  RequireScopes,
} from '@app/fiscal-core';
import type {
  AuthenticatedRequest,
  BillingPrincipal,
  FiscalDocumentView,
  FiscalDocumentsPrincipal,
} from '@app/fiscal-core';
import { parseEnvironment } from '@app/platform';
import {
  CreateFiscalDocumentDto,
  ListFiscalDocumentsDto,
  RequestVoidDto,
} from './fiscal-document.dto';
import { FiscalDocumentsExceptionFilter } from './fiscal-documents.filter';

@Controller('fiscal-documents')
@UseFilters(FiscalDocumentsExceptionFilter)
export class FiscalDocumentsController {
  constructor(
    private readonly documents: FiscalDocumentsService,
    private readonly artifacts: DocumentArtifactsService,
  ) {}

  @Post()
  @HttpCode(202)
  @RequireScopes('documents:write')
  async create(
    @Body() body: CreateFiscalDocumentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: BillingPrincipal,
    @Req() request: Request,
  ): Promise<AcceptedFiscalDocument> {
    const view = await this.documents.create(toDocumentsPrincipal(principal, request), {
      idempotencyKey: idempotencyKey ?? '',
      input: body,
    });
    const publicUrl = parseEnvironment(process.env).BILLING_PUBLIC_URL;
    return {
      id: view.id,
      documentType: view.documentType,
      series: view.series,
      number: view.number,
      status: view.status,
      statusUrl: `${publicUrl}/api/v1/fiscal-documents/${view.id}`,
    };
  }

  @Get()
  @RequireScopes('documents:read')
  list(
    @Query() query: ListFiscalDocumentsDto,
    @CurrentPrincipal() principal: BillingPrincipal,
    @Req() request: Request,
  ): Promise<readonly FiscalDocumentView[]> {
    return this.documents.list(toDocumentsPrincipal(principal, request), query);
  }

  @Get(':documentId')
  @RequireScopes('documents:read')
  get(
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: BillingPrincipal,
    @Req() request: Request,
  ): Promise<FiscalDocumentView> {
    return this.documents.get(toDocumentsPrincipal(principal, request), documentId);
  }

  @Post(':documentId/void-requests')
  @HttpCode(202)
  @RequireScopes('documents:write')
  requestVoid(
    @Param('documentId') documentId: string,
    @Body() body: RequestVoidDto,
    @CurrentPrincipal() principal: BillingPrincipal,
    @Req() request: Request,
  ): Promise<FiscalDocumentView> {
    return this.documents.requestVoid(toDocumentsPrincipal(principal, request), {
      documentId,
      reason: body.reason,
    });
  }

  @Get(':documentId/artifacts/:kind')
  @RequireScopes('documents:read')
  artifact(
    @Param('documentId') documentId: string,
    @Param('kind') kind: ArtifactReference['kind'],
    @CurrentPrincipal() principal: BillingPrincipal,
  ): Promise<{ readonly url: string; readonly expiresInSeconds: number }> {
    return this.artifacts.createSignedUrl(principal, documentId, kind);
  }
}

function toDocumentsPrincipal(
  principal: BillingPrincipal,
  request: Request,
): FiscalDocumentsPrincipal {
  if (!principal.organizationId) {
    throw new Error('An organization context is required');
  }
  const base = {
    organizationId: principal.organizationId,
    correlationId: (request as AuthenticatedRequest).correlationId,
  };
  return principal.kind === 'service'
    ? { ...base, serviceAccountId: principal.serviceAccountId }
    : { ...base, subject: principal.subject };
}
