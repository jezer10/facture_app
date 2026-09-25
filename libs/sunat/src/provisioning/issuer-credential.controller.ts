import { Body, Controller, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';

import { InternalServiceAuthGuard } from './internal-service-auth.guard';
import { ProvisionIssuerCredentialDto } from './issuer-credential.dto';
import {
  type IssuerCredentialStatus,
  IssuerCredentialProvisioningService,
} from './issuer-credential-provisioning.service';

@Controller('internal/issuers/:issuerId/sunat-credentials')
@UseGuards(InternalServiceAuthGuard)
export class IssuerCredentialController {
  constructor(private readonly provisioning: IssuerCredentialProvisioningService) {}

  @Put()
  @HttpCode(200)
  provision(
    @Param('issuerId') issuerId: string,
    @Body() input: ProvisionIssuerCredentialDto,
  ): Promise<IssuerCredentialStatus> {
    return this.provisioning.provision({ issuerId, ...input });
  }

  @Get()
  async status(
    @Param('issuerId') issuerId: string,
  ): Promise<
    { configured: false; issuerId: string } | ({ configured: true } & IssuerCredentialStatus)
  > {
    const status = await this.provisioning.status(issuerId);
    return status ? { configured: true, ...status } : { configured: false, issuerId };
  }
}
