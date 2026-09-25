import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CORE_ARTIFACTS_QUEUE } from '@app/contracts';
import { ObjectStorageModule } from '@app/platform';
import { PdfArtifactProcessor } from './pdf-artifact.processor';
import { PdfRendererService } from './pdf-renderer.service';
import { DocumentEmailService } from '../email/document-email.service';

@Module({
  imports: [ObjectStorageModule, BullModule.registerQueue({ name: CORE_ARTIFACTS_QUEUE })],
  providers: [PdfArtifactProcessor, PdfRendererService, DocumentEmailService],
  exports: [PdfRendererService],
})
export class PdfArtifactsWorkerModule {}
