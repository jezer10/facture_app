import { Controller, Get, Header, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CurrentPrincipal,
  RequireScopes,
  RequireAdmin,
  type BillingPrincipal,
} from '@app/fiscal-core';
import { parseEnvironment } from '@app/platform';

interface IntegrationView {
  accounts: { id: string; name: string }[];
  keys: { id: string; prefix: string; revoked_at: string | null }[];
}
interface WorkspaceView {
  id: string;
  name: string;
  environment: 'sandbox' | 'production';
  companyId: string | null;
  verified: boolean;
  sunat: string;
  email: string;
  fiscalValidity: boolean;
  canIssue: boolean;
  activation: string;
  message: string;
  verifiedRecipients: string[];
  capabilities: { documentTypes: string[]; voids: boolean; received: boolean };
}
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly database: DataSource) {}
  @Get('integration')
  @RequireAdmin()
  @Header('Cache-Control', 'no-store')
  async integration(@CurrentPrincipal() principal: BillingPrincipal): Promise<IntegrationView> {
    if (!principal.organizationId) throw new ForbiddenException();
    const accounts = await this.database.query<IntegrationView['accounts']>(
      'SELECT id,name FROM service_accounts WHERE organization_id=$1 ORDER BY created_at DESC',
      [principal.organizationId],
    );
    const keys = await this.database.query<IntegrationView['keys']>(
      'SELECT id,prefix,revoked_at FROM api_keys WHERE organization_id=$1 ORDER BY created_at DESC',
      [principal.organizationId],
    );
    return { accounts, keys };
  }
  @Get()
  @RequireScopes('documents:read')
  @Header('Cache-Control', 'no-store')
  async view(@CurrentPrincipal() principal: BillingPrincipal): Promise<WorkspaceView> {
    if (!principal.organizationId) throw new ForbiddenException();
    const [workspace] = await this.database.query<
      {
        id: string;
        name: string;
        environment: 'sandbox' | 'production';
        verified: boolean;
        companyId: string | null;
      }[]
    >(
      'SELECT id,name,environment,company_id AS "companyId",verified_at IS NOT NULL AS verified FROM organizations WHERE id=$1',
      [principal.organizationId],
    );
    if (!workspace) throw new ForbiddenException();
    const recipients = await this.database.query<{ email: string }[]>(
      'SELECT email FROM verified_email_recipients WHERE organization_id=$1 ORDER BY email',
      [workspace.id],
    );
    const env = parseEnvironment(process.env);
    return {
      ...workspace,
      sunat: workspace.environment === 'sandbox' ? 'beta' : 'production',
      email: env.BILLING_EMAIL_MODE,
      fiscalValidity: false,
      canIssue: workspace.environment === 'sandbox' && env.SUNAT_PROVIDER_MODE === 'beta',
      activation:
        workspace.environment === 'sandbox' ? 'sandbox_ready' : 'sunat_connection_pending',
      message:
        workspace.environment === 'sandbox'
          ? 'Sandbox conectado a SUNAT beta. Los comprobantes no tienen validez fiscal.'
          : 'Empresa validada. Configura las credenciales y el certificado; la conexión productiva de Facture aún está pendiente de habilitación.',
      verifiedRecipients: recipients.map((row) => row.email),
      capabilities: { documentTypes: ['01', '03', '07', '08'], voids: true, received: false },
    };
  }
}
