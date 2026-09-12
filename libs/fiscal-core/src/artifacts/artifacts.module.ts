import { Module } from '@nestjs/common';
import { ObjectStorageModule } from '@app/platform';
import { DocumentArtifactsService } from './document-artifacts.service';

@Module({
  imports: [ObjectStorageModule],
  providers: [DocumentArtifactsService],
  exports: [DocumentArtifactsService],
})
export class ArtifactsModule {}
