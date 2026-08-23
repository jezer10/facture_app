import { Module } from '@nestjs/common';
import { FiscalDocumentsService } from './fiscal-documents.service';

@Module({ providers: [FiscalDocumentsService], exports: [FiscalDocumentsService] })
export class DocumentsModule {}
