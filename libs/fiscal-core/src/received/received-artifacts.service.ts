import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OBJECT_STORAGE_PORT, parseEnvironment } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';
import type { BillingPrincipal } from '../auth';
import { ReceivedDocumentArtifactEntity } from '../database/entities';
import { ReceivedDocumentsService } from './received-documents.service';

@Injectable()
export class ReceivedArtifactsService {
  constructor(
    private readonly documents: ReceivedDocumentsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  async createSignedUrl(
    principal: BillingPrincipal,
    documentId: string,
    requestedKind: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    // The legacy migration stores source JSON under canonical-json.
    const kind = requestedKind === 'source' ? 'canonical-json' : requestedKind;
    if (kind !== 'pdf' && kind !== 'canonical-json') {
      throw new NotFoundException('Requested artifact is not available');
    }
    // Includes organization isolation and the service account's issuer grant.
    const document = await this.documents.getReceivedDocument(principal, documentId);
    const artifact = await this.dataSource.getRepository(ReceivedDocumentArtifactEntity).findOne({
      where: { organizationId: document.organizationId, receivedDocumentId: document.id, kind },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    const extension = kind === 'pdf' ? 'pdf' : 'json';
    const contentType = kind === 'pdf' ? 'application/pdf' : 'application/json';
    if (
      !artifact ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
      artifact.objectKey !== `received/${document.id}/${kind}-${artifact.sha256}.${extension}` ||
      artifact.contentType !== contentType ||
      !Number.isSafeInteger(Number(artifact.sizeBytes)) ||
      Number(artifact.sizeBytes) <= 0
    ) {
      throw new NotFoundException('Requested artifact is not available');
    }
    const expiresInSeconds = parseEnvironment(process.env).R2_SIGNED_URL_TTL_SECONDS;
    return {
      url: await this.storage.createReadUrl(artifact.objectKey, expiresInSeconds),
      expiresInSeconds,
    };
  }
}
