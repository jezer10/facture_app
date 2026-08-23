import { Module } from '@nestjs/common';
import { ReceivedDocumentsService } from './received-documents.service';

@Module({ providers: [ReceivedDocumentsService], exports: [ReceivedDocumentsService] })
export class ReceivedModule {}
