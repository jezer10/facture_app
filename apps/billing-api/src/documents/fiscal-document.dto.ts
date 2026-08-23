import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsDecimal,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { CreateFiscalDocumentInput } from '@app/contracts';

export class FiscalAddressDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(250)
  line!: string;

  @IsOptional() @IsString() @MaxLength(80) district?: string;
  @IsOptional() @IsString() @MaxLength(80) province?: string;
  @IsOptional() @IsString() @MaxLength(80) department?: string;
  @IsOptional() @Matches(/^[0-9]{6}$/u) ubigeo?: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/u) countryCode?: string;
}

export class FiscalPartyDto {
  @IsIn(['0', '1', '4', '6', '7', 'A', 'B', 'C', 'D'])
  identityType!: '0' | '1' | '4' | '6' | '7' | 'A' | 'B' | 'C' | 'D';

  @Matches(/^[A-Za-z0-9-]{1,20}$/u)
  identityNumber!: string;

  @IsString() @IsNotEmpty() @MaxLength(200) legalName!: string;
  @IsOptional() @IsString() @MaxLength(200) tradeName?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => FiscalAddressDto)
  address?: FiscalAddressDto;
}

export class FiscalDocumentLineDto {
  @IsOptional() @IsString() @MaxLength(80) itemCode?: string;
  @IsString() @IsNotEmpty() @MaxLength(500) description!: string;
  @Matches(/^[A-Z0-9]{2,5}$/u) unitCode!: string;
  @IsDecimal({ decimal_digits: '0,10', force_decimal: false }) quantity!: string;
  @IsDecimal({ decimal_digits: '0,10', force_decimal: false }) unitValue!: string;
  @IsIn(['taxed', 'exonerated', 'unaffected', 'free'])
  taxAffectation!: 'taxed' | 'exonerated' | 'unaffected' | 'free';
  @IsDecimal({ decimal_digits: '0,6', force_decimal: false }) taxRate!: string;

  @ValidateIf((line: FiscalDocumentLineDto) => line.taxAffectation === 'free')
  @IsIn(['taxed', 'exonerated', 'unaffected'])
  freeTaxTreatment?: 'taxed' | 'exonerated' | 'unaffected';

  @ValidateIf((line: FiscalDocumentLineDto) => line.taxAffectation === 'free')
  @IsDecimal({ decimal_digits: '0,10', force_decimal: false })
  referenceUnitValue?: string;

  @IsOptional()
  @IsDecimal({ decimal_digits: '0,10', force_decimal: false })
  discountAmount?: string;
}

export class DocumentReferenceDto {
  @IsUUID() documentId!: string;
  @IsIn(['01', '03']) documentType!: '01' | '03';
  @Matches(/^[A-Z0-9]{4}$/u) series!: string;
  @Matches(/^[0-9]{1,20}$/u) number!: string;
  @Matches(/^[A-Za-z0-9]{1,4}$/u) reasonCode!: string;
  @IsString() @IsNotEmpty() @MaxLength(500) reasonDescription!: string;
}

export class CreateFiscalDocumentDto implements CreateFiscalDocumentInput {
  @IsUUID() issuerId!: string;
  @IsIn(['01', '03', '07', '08']) documentType!: '01' | '03' | '07' | '08';
  @IsUUID() seriesId!: string;
  @IsDateString({ strict: true }) issueDate!: string;
  @IsIn(['PEN', 'USD']) currency!: 'PEN' | 'USD';

  @ValidateNested()
  @Type(() => FiscalPartyDto)
  customer!: FiscalPartyDto;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FiscalDocumentLineDto)
  lines!: FiscalDocumentLineDto[];

  @ValidateIf(
    (document: CreateFiscalDocumentDto) =>
      document.documentType === '07' || document.documentType === '08',
  )
  @ValidateNested()
  @Type(() => DocumentReferenceDto)
  reference?: DocumentReferenceDto;

  @IsOptional() @IsString() @MaxLength(80) purchaseOrder?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  notes?: string[];
}

export class ListFiscalDocumentsDto {
  @IsOptional() @IsUUID() issuerId?: string;
  @IsOptional()
  @IsIn([
    'queued',
    'processing',
    'accepted',
    'accepted_with_observations',
    'rejected',
    'failed',
    'void_pending',
    'voided',
  ])
  status?:
    | 'queued'
    | 'processing'
    | 'accepted'
    | 'accepted_with_observations'
    | 'rejected'
    | 'failed'
    | 'void_pending'
    | 'voided';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset = 0;
}

export class RequestVoidDto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}
