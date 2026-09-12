import { Module } from '@nestjs/common';
import { ObjectStorageModule } from '@app/platform';
import { RecipientQueryService } from './recipient-query.service';

@Module({
  imports: [ObjectStorageModule],
  providers: [RecipientQueryService],
  exports: [RecipientQueryService],
})
export class RecipientQueryModule {}
