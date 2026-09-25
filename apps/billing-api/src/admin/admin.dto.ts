import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBase64,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { API_KEY_SCOPES } from '@app/fiscal-core';

export class CreateOrganizationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  @MaxLength(80)
  slug!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  ownerSubject!: string;
}

export class CreateServiceAccountDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;
}

export class CreateIssuerDto {
  @Matches(/^[0-9]{11}$/u)
  ruc!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legalName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tradeName?: string;

  @IsOptional()
  @IsObject()
  address?: Record<string, string>;
}

export class CreateIssuerSeriesDto {
  @IsIn(['01', '03', '07', '08'])
  documentType!: '01' | '03' | '07' | '08';

  @Matches(/^[A-Z0-9]{4}$/u)
  series!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  nextNumber = 1;
}

export class GrantIssuerDto {
  @IsUUID()
  issuerId!: string;
}

export class CreateApiKeyDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(API_KEY_SCOPES, { each: true })
  scopes!: (typeof API_KEY_SCOPES)[number][];

  @IsOptional()
  @IsDateString({ strict: true })
  expiresAt?: string;
}

export class ProvisionSunatCredentialDto {
  @IsIn(['beta', 'production'])
  environment!: 'beta' | 'production';

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  solUsername!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  solPassword!: string;

  @ValidateIf(
    (input: ProvisionSunatCredentialDto) =>
      input.certificatePkcs12Base64 !== undefined || input.certificatePassword !== undefined,
  )
  @IsBase64()
  @MaxLength(2_800_000)
  certificatePkcs12Base64?: string;

  @ValidateIf(
    (input: ProvisionSunatCredentialDto) =>
      input.certificatePkcs12Base64 !== undefined || input.certificatePassword !== undefined,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  certificatePassword?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  certificateExpiresAt?: string;
}

export class ConfigureWebhookSubscriptionDto {
  @IsUrl({ require_protocol: true })
  endpointUrl!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  eventTypes!: string[];

  @IsOptional()
  @IsString()
  @MinLength(32)
  @MaxLength(512)
  secret?: string;

  @IsBoolean()
  enabled!: boolean;
}
