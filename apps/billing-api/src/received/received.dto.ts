import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class RequestReceivedSyncDto {
  @IsUUID()
  issuerId!: string;

  @IsDateString({ strict: true })
  startDate!: string;

  @IsDateString({ strict: true })
  endDate!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(['01', '03', '07', '08'], { each: true })
  documentTypes!: ('01' | '03' | '07' | '08')[];
}

export class ListReceivedDocumentsQuery {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}
