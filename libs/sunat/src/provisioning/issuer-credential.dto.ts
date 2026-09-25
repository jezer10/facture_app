import {
  IsBase64,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ProvisionIssuerCredentialDto {
  @IsUUID()
  organizationId!: string;

  @Matches(/^\d{11}$/u)
  issuerRuc!: string;

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

  @IsOptional()
  @IsBase64()
  @MaxLength(2_800_000)
  certificatePkcs12Base64?: string;

  @ValidateIf((input: ProvisionIssuerCredentialDto) => Boolean(input.certificatePkcs12Base64))
  @IsString()
  @Length(1, 300)
  certificatePassword?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  certificateExpiresAt?: string;
}
