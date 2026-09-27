import type { CreateFiscalDocumentInput, PublicDocumentStatus } from '@app/contracts';

interface BaseFiscalDocumentsPrincipal {
  readonly organizationId: string;
  readonly correlationId: string;
}

export interface ServiceAccountPrincipal extends BaseFiscalDocumentsPrincipal {
  readonly serviceAccountId: string;
  readonly subject?: never;
}

export interface HumanAdministratorPrincipal extends BaseFiscalDocumentsPrincipal {
  readonly serviceAccountId?: undefined;
  readonly subject: string;
}

export type FiscalDocumentsPrincipal = ServiceAccountPrincipal | HumanAdministratorPrincipal;

export interface CreateFiscalDocumentCommand {
  readonly idempotencyKey: string;
  readonly input: CreateFiscalDocumentInput;
}

export interface ListFiscalDocumentsQuery {
  readonly issuerId?: string;
  readonly status?: PublicDocumentStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface RequestFiscalDocumentVoidCommand {
  readonly documentId: string;
  readonly reason: string;
}

export type { FiscalDocumentView } from '@app/contracts';
