import {
  ApiKeyCreationRequestEntity,
  ApiKeyEntity,
  CatalogItemEntity,
  CustomerEntity,
  IssuerEntity,
  IssuerSeriesEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
  ServiceAccountEntity,
  ServiceAccountIssuerGrantEntity,
} from './tenancy.entities';
import {
  DocumentArtifactEntity,
  DocumentStateHistoryEntity,
  FiscalDocumentEntity,
  FiscalDocumentLineEntity,
} from './fiscal-document.entities';
import {
  AuditLogEntity,
  IdempotencyRequestEntity,
  InboxMessageEntity,
  OutboxEventEntity,
  ReceivedDocumentEntity,
  ReceivedDocumentArtifactEntity,
  ReceivedSyncEntity,
} from './reliability.entities';

export * from './fiscal-document.entities';
export * from './reliability.entities';
export * from './tenancy.entities';

export const CORE_ENTITIES = [
  OrganizationEntity,
  OrganizationMemberEntity,
  ServiceAccountEntity,
  ApiKeyEntity,
  ApiKeyCreationRequestEntity,
  IssuerEntity,
  ServiceAccountIssuerGrantEntity,
  IssuerSeriesEntity,
  CustomerEntity,
  CatalogItemEntity,
  FiscalDocumentEntity,
  FiscalDocumentLineEntity,
  DocumentArtifactEntity,
  DocumentStateHistoryEntity,
  IdempotencyRequestEntity,
  OutboxEventEntity,
  InboxMessageEntity,
  ReceivedSyncEntity,
  ReceivedDocumentEntity,
  ReceivedDocumentArtifactEntity,
  AuditLogEntity,
] as const;
