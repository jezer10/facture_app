import { IsDateString, IsDecimal, IsIn, Matches } from 'class-validator';

export class RecipientQueryDto {
  @Matches(/^[0-9]{11}$/u)
  issuerRuc!: string;

  @IsIn(['01', '03', '07', '08'])
  documentType!: '01' | '03' | '07' | '08';

  @Matches(/^[A-Z0-9]{4}$/u)
  series!: string;

  @Matches(/^[0-9]{1,20}$/u)
  number!: string;

  @IsDateString({ strict: true })
  issueDate!: string;

  @IsDecimal({ decimal_digits: '2', force_decimal: true })
  total!: string;

  @Matches(/^[A-Za-z0-9-]{1,20}$/u)
  recipientIdentityNumber!: string;
}
