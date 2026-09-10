import { Module } from '@nestjs/common';
import { ObjectStorageModule } from '@app/platform';
import { ReceivedDocumentsService } from './received-documents.service';
import { ReceivedArtifactsService } from './received-artifacts.service';

@Module({
  imports: [ObjectStorageModule],
  providers: [ReceivedDocumentsService, ReceivedArtifactsService],
  exports: [ReceivedDocumentsService, ReceivedArtifactsService],
})
export class ReceivedModule {}
