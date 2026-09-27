import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { IsBoolean, IsIn, ValidateIf, IsString, MaxLength, MinLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  CurrentPrincipal,
  PublicRoute,
  RequirePlatformAdmin,
  type BillingPrincipal,
} from '@app/fiscal-core';
import {
  BrowserSessionService,
  CompanyRegistrationService,
  type Registration,
} from '@app/fiscal-core';

export class CompanyDraftDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(11)
  ruc?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(200)
  legalName?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(400)
  address?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(160)
  representativeName?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['owner', 'representative', 'authorized', ''])
  relationship?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(1500)
  authorityExplanation?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(4)
  series?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsBoolean() declaration?: boolean;
}
export class CompanyDecisionDto {
  @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
  @IsString() @MinLength(10) @MaxLength(800) note!: string;
  @IsString() @MaxLength(1000) evidenceReference!: string;
  @IsBoolean() registryChecked!: boolean;
  @IsBoolean() authorityChecked!: boolean;
}
// PublicRoute bypasses only the organization guard. Every handler requires a browser
// identity and unsafe requests enforce both origin and CSRF through identity().
@Controller('company-registrations')
@PublicRoute()
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class CompanyRegistrationController {
  constructor(
    private readonly sessions: BrowserSessionService,
    private readonly companies: CompanyRegistrationService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: Request): Promise<Registration[]> {
    return this.companies.list((await this.sessions.identity(request)).subject);
  }
  @Put(':id')
  async save(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() data: CompanyDraftDto,
  ): Promise<Registration> {
    return this.companies.save(await this.sessions.identity(request), id, data);
  }
  @Post(':id/submit')
  async submit(
    @Req() request: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Registration> {
    return this.companies.submit((await this.sessions.identity(request)).subject, id);
  }
}
@Controller('admin/company-registrations')
@RequirePlatformAdmin()
export class CompanyReviewController {
  constructor(private readonly companies: CompanyRegistrationService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(): Promise<Registration[]> {
    return this.companies.reviewQueue();
  }
  @Post(':id/decision')
  decide(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() actor: BillingPrincipal,
    @Body() body: CompanyDecisionDto,
  ): Promise<Registration> {
    if (actor.kind !== 'human' || !actor.platformAdmin) throw new ForbiddenException();
    if (body.decision === 'approve' && (!body.registryChecked || !body.authorityChecked))
      throw new ForbiddenException('Comprueba el registro y la representación antes de aprobar.');
    return this.companies.decide(
      id,
      actor.subject,
      body.decision,
      body.note,
      body.evidenceReference,
    );
  }
}
