import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { ArtifactReference } from '@app/contracts';
import { OBJECT_STORAGE_PORT, parseEnvironment } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';
import type { BillingPrincipal } from '../auth';
import {
  DocumentArtifactEntity,
  FiscalDocumentEntity,
  ServiceAccountIssuerGrantEntity,
} from '../database/entities';
import {
  assertStoredDocumentArtifact,
  parseDocumentArtifactKind,
} from './document-artifact-policy';

@Injectable()
export class DocumentArtifactsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  // The controller first authorizes document access through FiscalDocumentsService.
  async emailDelivery(documentId: string): Promise<Record<string, unknown>> {
    const [delivery] = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT status, recipient, attempts, sent_at AS "sentAt", error_code AS "errorCode"
       FROM document_email_deliveries WHERE document_id=$1`,
      [documentId],
    );
    if (delivery) return { ...delivery, channel: 'mailpit-local' };
    const [document] = await this.dataSource.query<{ recipient: string | null }[]>(
      `SELECT fiscal_snapshot->'customer'->>'email' AS recipient FROM fiscal_documents WHERE id=$1`,
      [documentId],
    );
    return {
      status:
        parseEnvironment(process.env).BILLING_EMAIL_MODE === 'disabled'
          ? 'disabled'
          : document?.recipient
            ? 'waiting_for_artifacts'
            : 'not_requested',
      channel: 'mailpit-local',
    };
  }

  async createSignedUrl(
    principal: BillingPrincipal,
    documentId: string,
    kind: ArtifactReference['kind'],
  ): Promise<{ url: string; expiresInSeconds: number }> {
    let requestedKind: ArtifactReference['kind'];
    try {
      requestedKind = parseDocumentArtifactKind(kind);
    } catch {
      throw new NotFoundException('Requested artifact is not available');
    }
    if (!principal.organizationId) {
      throw new NotFoundException('Fiscal document was not found');
    }
    const document = await this.dataSource.getRepository(FiscalDocumentEntity).findOneBy({
      id: documentId,
      organizationId: principal.organizationId,
    });
    if (!document) {
      throw new NotFoundException('Fiscal document was not found');
    }
    if (principal.kind === 'service') {
      const grant = await this.dataSource.getRepository(ServiceAccountIssuerGrantEntity).existsBy({
        organizationId: principal.organizationId,
        serviceAccountId: principal.serviceAccountId,
        issuerId: document.issuerId,
      });
      if (!grant) {
        throw new NotFoundException('Fiscal document was not found');
      }
    }
    const artifact = await this.dataSource.getRepository(DocumentArtifactEntity).findOne({
      where: { documentId, kind: requestedKind },
      order: { createdAt: 'DESC' },
    });
    if (!artifact) {
      throw new NotFoundException('Requested artifact is not available');
    }
    assertStoredDocumentArtifact(artifact, {
      organizationId: document.organizationId,
      issuerId: document.issuerId,
      documentId: document.id,
    });
    const expiresInSeconds = parseEnvironment(process.env).R2_SIGNED_URL_TTL_SECONDS;
    return {
      url: await this.storage.createReadUrl(artifact.objectKey, expiresInSeconds),
      expiresInSeconds,
    };
  }
}
