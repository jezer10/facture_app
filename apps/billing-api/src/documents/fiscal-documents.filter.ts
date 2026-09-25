import { ArgumentsHost, Catch, HttpStatus } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { FiscalValidationError } from '@app/fiscal-domain';
import { FiscalDocumentsError } from '@app/fiscal-core';

@Catch(FiscalDocumentsError, FiscalValidationError)
export class FiscalDocumentsExceptionFilter implements ExceptionFilter {
  catch(exception: FiscalDocumentsError | FiscalValidationError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof FiscalValidationError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'INVALID_FISCAL_DOCUMENT',
        issues: exception.issues,
      });
      return;
    }
    response.status(statusFor(exception.code)).json({
      statusCode: statusFor(exception.code),
      code: exception.code,
      message: publicMessage(exception),
    });
  }
}

function statusFor(code: FiscalDocumentsError['code']): number {
  if (code === 'IDEMPOTENCY_CONFLICT') return HttpStatus.CONFLICT;
  if (code === 'DOCUMENT_NOT_FOUND') return HttpStatus.NOT_FOUND;
  if (code === 'ISSUER_ACCESS_DENIED') return HttpStatus.FORBIDDEN;
  if (code === 'ISSUER_UNAVAILABLE' || code === 'SERIES_UNAVAILABLE') {
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }
  if (code === 'IDEMPOTENCY_RESOURCE_MISSING') return HttpStatus.INTERNAL_SERVER_ERROR;
  return HttpStatus.BAD_REQUEST;
}

function publicMessage(exception: FiscalDocumentsError): string {
  if (exception.code === 'ISSUER_ACCESS_DENIED' || exception.code === 'DOCUMENT_NOT_FOUND') {
    return 'The requested fiscal resource was not found or is not accessible';
  }
  return exception.message;
}
