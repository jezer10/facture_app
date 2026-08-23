import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { OBJECT_STORAGE_PORT, parseEnvironment } from '@app/platform';
import type { ObjectStoragePort } from '@app/platform';
import { DocumentArtifactEntity, FiscalDocumentEntity, IssuerEntity } from '../database/entities';

export interface RecipientQueryProof {
  readonly issuerRuc: string;
  readonly documentType: '01' | '03' | '07' | '08';
  readonly series: string;
  readonly number: string;
  readonly issueDate: string;
  readonly total: string;
  readonly recipientIdentityNumber: string;
}

export type RecipientQueryResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly document: {
        readonly documentType: string;
        readonly series: string;
        readonly number: string;
        readonly issueDate: string;
        readonly status: string;
        readonly artifacts: Readonly<Record<string, string>>;
      };
    };

@Injectable()
export class RecipientQueryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  async query(proof: RecipientQueryProof): Promise<RecipientQueryResult> {
    const issuer = await this.dataSource
      .getRepository(IssuerEntity)
      .findOneBy({ ruc: proof.issuerRuc });
    if (!issuer) {
      return { found: false };
    }
    const document = await this.dataSource.getRepository(FiscalDocumentEntity).findOneBy({
      issuerId: issuer.id,
      documentType: proof.documentType,
      series: proof.series,
      number: proof.number,
      issueDate: proof.issueDate,
    });
    if (!document || !isValidProof(document, proof)) {
      return { found: false };
    }

    const artifacts = await this.dataSource.getRepository(DocumentArtifactEntity).find({
      where: { documentId: document.id },
      order: { createdAt: 'DESC' },
    });
    const ttl = parseEnvironment(process.env).R2_SIGNED_URL_TTL_SECONDS;
    const artifactUrls: Record<string, string> = {};
    for (const artifact of artifacts) {
      artifactUrls[artifact.kind] ??= await this.storage.createReadUrl(artifact.objectKey, ttl);
    }

    return {
      found: true,
      document: {
        documentType: document.documentType,
        series: document.series,
        number: document.number,
        issueDate: document.issueDate,
        status: document.status,
        artifacts: artifactUrls,
      },
    };
  }
}

function isValidProof(document: FiscalDocumentEntity, proof: RecipientQueryProof): boolean {
  const identity = document.customerSnapshot.identityNumber;
  const amount = String(document.totals.payableAmount ?? '');
  try {
    return identity === proof.recipientIdentityNumber && new Decimal(amount).equals(proof.total);
  } catch {
    return false;
  }
}
