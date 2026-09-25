import { IssuerCredentialEntity } from './issuer-credential.entity';
import {
  SunatCommandInboxEntity,
  SunatReceivedSyncCursorEntity,
  SunatSubmissionAttemptEntity,
  SunatSubmissionEntity,
  SunatSubmissionTicketEntity,
} from './reliability.entities';

export * from './issuer-credential.entity';
export * from './reliability.entities';

export const SUNAT_ENTITIES = [
  IssuerCredentialEntity,
  SunatCommandInboxEntity,
  SunatSubmissionEntity,
  SunatSubmissionAttemptEntity,
  SunatSubmissionTicketEntity,
  SunatReceivedSyncCursorEntity,
] as const;
