import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { OBJECT_STORAGE_PORT, parseEnvironment, type ObjectStoragePort } from '@app/platform';
import { assertStoredDocumentArtifact } from '../artifacts/document-artifact-policy';

interface Delivery {
  document_id: string;
  recipient: string;
  attempts: number;
}
interface DocumentRow {
  id: string;
  organization_id: string;
  issuer_id: string;
  series: string;
  number: string;
  fiscal_snapshot: Record<string, unknown>;
}
interface ArtifactRow {
  kind: string;
  objectKey: string;
  sha256: string;
  contentType: string;
  sizeBytes: string;
}

@Injectable()
export class DocumentEmailService {
  private running = false;
  private readonly logger = new Logger(DocumentEmailService.name);
  private readonly env = parseEnvironment(process.env);
  // Deliberately local-only until a real sender/provider is configured and tested.
  private readonly transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: 51025,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  constructor(
    @InjectDataSource() private readonly database: DataSource,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  @Interval(3000)
  async deliverPending(): Promise<void> {
    if (this.running || this.env.BILLING_EMAIL_MODE !== 'mailpit') return;
    this.running = true;
    try {
      // A committed PDF + signed XML + CDR is the durable handoff. A crash after
      // PDF creation cannot lose the delivery request, and document_id deduplicates it.
      await this.database.query(`INSERT INTO document_email_deliveries(document_id, recipient)
        SELECT d.id, d.fiscal_snapshot->'customer'->>'email' FROM fiscal_documents d
        WHERE d.status IN ('accepted','accepted_with_observations') AND d.accepted_at IS NOT NULL
        AND d.fiscal_snapshot->>'environment' = 'beta'
        AND length(coalesce(d.fiscal_snapshot->'customer'->>'email','')) > 0
        AND (SELECT count(DISTINCT a.kind) FROM document_artifacts a WHERE a.document_id=d.id AND a.kind IN ('pdf','signed-xml','cdr')) = 3
        ON CONFLICT(document_id) DO NOTHING`);
      await this.database
        .query(`UPDATE document_email_deliveries SET status='unconfirmed', error_code='EMAIL_INTERRUPTED', updated_at=now()
        WHERE status='sending' AND updated_at < now() - interval '5 minutes'`);
      const rows = await this.database.query<Delivery[]>(`WITH candidates AS (
        SELECT e.document_id FROM document_email_deliveries e JOIN fiscal_documents d ON d.id=e.document_id
        WHERE e.status='pending' AND e.available_at <= now() AND d.status IN ('accepted','accepted_with_observations')
        ORDER BY e.available_at FOR UPDATE OF e SKIP LOCKED LIMIT 5
      ), claimed AS (
        UPDATE document_email_deliveries e SET status='sending', attempts=attempts+1, updated_at=now()
        FROM candidates c WHERE e.document_id=c.document_id RETURNING e.document_id,e.recipient,e.attempts
      ) SELECT * FROM claimed`);
      for (const row of rows) await this.deliver(row);
    } catch {
      this.logger.error('No se pudo procesar la cola de correo local.');
    } finally {
      this.running = false;
    }
  }

  private async deliver(delivery: Delivery): Promise<void> {
    let smtpStarted = false;
    try {
      const [document] = await this.database.query<DocumentRow[]>(
        `SELECT id,organization_id,issuer_id,series,number,fiscal_snapshot FROM fiscal_documents
        WHERE id=$1 AND status IN ('accepted','accepted_with_observations')`,
        [delivery.document_id],
      );
      if (!document || document.fiscal_snapshot.environment !== 'beta')
        throw new Error('EMAIL_NOT_ELIGIBLE');
      const artifacts = await this.database.query<ArtifactRow[]>(
        `SELECT DISTINCT ON(kind) kind,object_key AS "objectKey",sha256,content_type AS "contentType",size_bytes AS "sizeBytes"
        FROM document_artifacts WHERE document_id=$1 AND kind IN ('pdf','signed-xml','cdr') ORDER BY kind,created_at DESC`,
        [document.id],
      );
      if (artifacts.length !== 3) throw new Error('EMAIL_ARTIFACTS_MISSING');
      const attachments = [];
      for (const artifact of artifacts) {
        assertStoredDocumentArtifact(artifact, {
          organizationId: document.organization_id,
          issuerId: document.issuer_id,
          documentId: document.id,
        });
        const content = await this.storage.get(artifact.objectKey);
        if (createHash('sha256').update(content).digest('hex') !== artifact.sha256)
          throw new Error('EMAIL_ARTIFACT_INTEGRITY');
        attachments.push({
          filename: `${artifact.kind === 'cdr' ? 'CDR-' : ''}${document.series}-${document.number}.${artifact.kind === 'pdf' ? 'pdf' : artifact.kind === 'cdr' ? 'zip' : 'xml'}`,
          content,
          contentType: artifact.contentType,
        });
      }
      const messageId = `<facture-beta-${document.id}@facture.local>`;
      smtpStarted = true;
      await this.transport.sendMail({
        from: 'Facture Beta <comprobantes@facture.test>',
        to: delivery.recipient,
        messageId,
        subject: `[PRUEBA BETA] Comprobante ${document.series}-${document.number}`,
        text: 'Adjuntamos el PDF, XML firmado y CDR de la prueba SUNAT beta. SIN VALIDEZ FISCAL. Este mensaje fue capturado por el buzón local y no representa una venta real.',
        attachments,
      });
      await this.database.query(
        `UPDATE document_email_deliveries SET status='sent',sent_at=now(),updated_at=now(),message_id=$2,error_code=NULL WHERE document_id=$1`,
        [document.id, messageId],
      );
    } catch {
      const status = smtpStarted ? 'unconfirmed' : delivery.attempts >= 5 ? 'failed' : 'pending';
      await this.database.query(
        `UPDATE document_email_deliveries SET status=$2,error_code=$3,available_at=now()+interval '30 seconds',updated_at=now() WHERE document_id=$1`,
        [
          delivery.document_id,
          status,
          smtpStarted ? 'EMAIL_DELIVERY_UNCONFIRMED' : 'EMAIL_PREPARATION_FAILED',
        ],
      );
    }
  }
}
