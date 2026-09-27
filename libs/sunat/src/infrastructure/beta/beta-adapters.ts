import type { DataSource } from 'typeorm';
import { zipSync } from 'fflate';
import { buildVoidXml } from './void-ubl';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SandboxUblBuilder } from './sandbox-ubl-builder';
import type { ObjectStoragePort } from '@app/platform';
import { readSecretFile } from '@app/platform';
import {
  signBetaInvoice,
  verifySignature,
  packageInvoice,
  betaEnvelope,
  sendToBeta,
  parseBetaResponse,
  betaOperationEnvelope,
  parseBetaTicket,
  parseBetaStatus,
  xmlEscape,
} from './protocol.cjs';
import {
  SunatSubmissionAmbiguousError,
  SunatUnsafeConfigurationError,
} from '../../domain/errors/sunat.error';
import {
  type FiscalDocumentIdentity,
  type FiscalDocumentSnapshot,
  toFiscalDocumentIdentity,
} from '../../domain/models/fiscal-document';
import type {
  IssuerCredentialHandle,
  SignedUblDocument,
  UnsignedUblDocument,
  SunatSubmissionOutcome,
  SunatReconciliationOutcome,
  SunatVoidOutcome,
} from '../../domain/models/sunat-outcome';
import type { XmlSignerPort } from '../../domain/ports/xml-signer.port';
import type { IssuerCredentialPort } from '../../domain/ports/issuer-credential.port';
import type { SunatProviderPort } from '../../domain/ports/sunat-provider.port';
import type { StoredSunatArtifact } from '../../domain/ports/sunat-artifact-store.port';

export function assertBetaOnly(): void {
  if (process.env.SUNAT_PROVIDER_MODE !== undefined && process.env.SUNAT_PROVIDER_MODE !== 'beta') {
    throw new SunatUnsafeConfigurationError('Sandbox requiere SUNAT_PROVIDER_MODE=beta.');
  }
}
const hash = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex');

export class BetaUblBuilder extends SandboxUblBuilder {}

export class BetaSigner implements XmlSignerPort {
  private readonly key: Buffer;
  readonly certificate: Buffer;
  readonly fingerprint: string;
  constructor(keyPath: string, certPath: string) {
    assertBetaOnly();
    this.key = readSecretFile(keyPath);
    this.certificate = readFileSync(certPath);
    this.fingerprint = new X509Certificate(this.certificate).fingerprint256;
  }
  sign(
    document: UnsignedUblDocument,
    credentials: IssuerCredentialHandle,
  ): Promise<SignedUblDocument> {
    if (credentials.environment !== 'beta')
      throw new SunatUnsafeConfigurationError('Credenciales incompatibles con beta.');
    const xml = signBetaInvoice(document.xml, this.key, this.certificate);
    return Promise.resolve({
      ...document,
      xml,
      sha256: hash(xml),
      signature: { state: 'signed', certificateFingerprint: this.fingerprint },
    });
  }
  readiness(): { ready: boolean; mode: 'signed'; detail: string } {
    return {
      ready: Date.parse(new X509Certificate(this.certificate).validTo) > Date.now(),
      mode: 'signed',
      detail: 'Certificado de prueba beta; sin validez fiscal.',
    };
  }
}

export class BetaCredentials implements IssuerCredentialPort {
  constructor() {
    assertBetaOnly();
  }
  resolve(issuerId: string): Promise<IssuerCredentialHandle> {
    return Promise.resolve({
      issuerId,
      credentialVersion: 1,
      environment: 'beta',
      certificateReference: null,
      certificateFingerprint: null,
      solCredentialReference: null,
    });
  }
  readiness(): Promise<{ ready: boolean; durable: boolean; detail: string }> {
    return Promise.resolve({
      ready: true,
      durable: false,
      detail: 'Autenticación pública MODDATOS exclusiva de SUNAT beta.',
    });
  }
}

export class BetaSunatProvider implements SunatProviderPort {
  constructor(
    private readonly storage: ObjectStoragePort,
    private readonly signer: BetaSigner,
    private readonly database?: DataSource,
  ) {
    assertBetaOnly();
  }
  private prefix(identity: FiscalDocumentIdentity, credentials: IssuerCredentialHandle): string {
    if (
      credentials.environment !== 'beta' ||
      !/^[a-f\d-]{36}$/iu.test(credentials.issuerId) ||
      !/^[a-f\d-]{36}$/iu.test(identity.documentId)
    )
      throw new SunatUnsafeConfigurationError('Identidad beta inválida.');
    return `sunat/beta/${credentials.issuerId}/${identity.documentId}`;
  }
  async submitDocument(
    document: SignedUblDocument,
    credentials: IssuerCredentialHandle,
    context?: { organizationId: string },
  ): Promise<SunatSubmissionOutcome> {
    if (!context || !/^[a-f\d-]{36}$/iu.test(context.organizationId))
      throw new SunatUnsafeConfigurationError('Falta organización del envío beta.');
    const prefix = this.prefix(document.identity, credentials);
    const publicPrefix = `sunat/${context.organizationId}/${credentials.issuerId}/documents/${document.identity.documentId}`;
    if (
      document.signature.state !== 'signed' ||
      !verifySignature(document.xml, this.signer.certificate)
    )
      throw new SunatUnsafeConfigurationError('Firma beta inválida.');
    const prior = await this.receipt(prefix);
    if (prior) return prior;
    const id = `${document.identity.series}-${document.identity.number}`;
    const file = `${document.identity.issuerRuc}-${document.identity.documentType}-${id}`;
    const zip = packageInvoice(file, document.xml);
    const zipArtifact = await this.putArtifact(publicPrefix, 'zip', zip, 'application/zip');
    try {
      const response = await sendToBeta(betaEnvelope(document.identity.issuerRuc, file, zip));
      // Save the received SOAP before interpreting it for diagnostics.
      await this.putArtifact(prefix, 'xml', Buffer.from(response.body), 'application/xml');
      const parsed = parseBetaResponse(response.body, id, file);
      if (parsed.status === 'soap_fault') throw new SunatSubmissionAmbiguousError(id);
      if (response.httpStatus !== 200 || !parsed.cdrZip)
        throw new SunatSubmissionAmbiguousError(id);
      const cdr = await this.putArtifact(publicPrefix, 'cdr', parsed.cdrZip, 'application/zip');
      const outcome: SunatSubmissionOutcome = {
        status: parsed.status === 'accepted_beta' ? 'accepted_with_observations' : 'rejected',
        providerTrackingId: id,
        responseCode: parsed.responseCode,
        description: parsed.description,
        observations: ['SUNAT_BETA_SIN_VALIDEZ_FISCAL', ...(parsed.observations ?? [])],
        cdrReference: cdr.objectKey,
        artifacts: [zipArtifact, cdr],
      };
      const body = Buffer.from(JSON.stringify(outcome));
      await this.storage.putImmutable({
        key: `${prefix}/receipt.json`,
        body,
        contentType: 'application/json',
        sha256: hash(body),
      });
      return outcome;
    } catch {
      // Never turn an uncertain send into a fresh submission retry.
      throw new SunatSubmissionAmbiguousError(id);
    }
  }
  private async receipt(prefix: string): Promise<SunatSubmissionOutcome | null> {
    try {
      return JSON.parse(
        (await this.storage.get(`${prefix}/receipt.json`)).toString('utf8'),
      ) as SunatSubmissionOutcome;
    } catch (error) {
      if (
        (error as { name?: string }).name === 'NoSuchKey' ||
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      )
        return null;
      throw error;
    }
  }
  async reconcileDocument(
    identity: FiscalDocumentIdentity,
    tracking: string | null,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatReconciliationOutcome> {
    if (tracking?.startsWith('void:'))
      return this.reconcileVoid(identity, credentials, tracking.slice(5));
    return (
      (await this.receipt(this.prefix(identity, credentials))) ?? {
        status: 'pending',
        providerTrackingId: `${identity.series}-${identity.number}`,
      }
    );
  }
  async storedArtifacts(
    identity: FiscalDocumentIdentity,
    credentials: IssuerCredentialHandle,
  ): Promise<readonly StoredSunatArtifact[]> {
    const prefix = this.prefix(identity, credentials);
    const outcome = await this.receipt(prefix);
    const voidOutcome = await this.readJson<SunatVoidOutcome>(`${prefix}/void-receipt.json`);
    return [
      ...(outcome && outcome.status !== 'pending' ? (outcome.artifacts ?? []) : []),
      ...(voidOutcome?.status === 'voided' ? (voidOutcome.artifacts ?? []) : []),
    ];
  }
  async submitVoidCommunication(
    identity: FiscalDocumentIdentity,
    reason: string,
    credentials: IssuerCredentialHandle,
    context?: { organizationId: string; snapshot: FiscalDocumentSnapshot },
  ): Promise<SunatVoidOutcome> {
    if (!context || context.snapshot.environment !== 'beta' || !this.database)
      throw new SunatUnsafeConfigurationError('Falta el contexto persistente de la baja.');
    const prefix = this.prefix(identity, credentials);
    const prior = await this.readJson<{ ticket: string }>(`${prefix}/void-ticket.json`);
    if (prior) return { status: 'pending', providerTrackingId: `void:${prior.ticket}` };
    if (await this.readJson(`${prefix}/void-intent.json`))
      throw new SunatSubmissionAmbiguousError('void:unconfirmed');
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Lima',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const [sequence] = await this.database.query<{ number: number }[]>(
      `INSERT INTO beta_summary_sequences(issuer_id,issue_date,number) VALUES($1,$2,1) ON CONFLICT(issuer_id,issue_date) DO UPDATE SET number=beta_summary_sequences.number+1 RETURNING number`,
      [credentials.issuerId, date],
    );
    if (!sequence)
      throw new SunatUnsafeConfigurationError('No se pudo reservar el correlativo de baja.');
    const built = buildVoidXml(context.snapshot, reason, date, String(sequence.number));
    const signed = await this.signer.sign(
      {
        identity: toFiscalDocumentIdentity(context.snapshot),
        xml: built.xml,
        sha256: hash(built.xml),
      },
      credentials,
    );
    const zip = Buffer.from(zipSync({ [`${built.file}.xml`]: Buffer.from(signed.xml) }));
    await this.putJson(`${prefix}/void-intent.json`, {
      id: built.id,
      file: built.file,
      organizationId: context.organizationId,
    });
    await this.putArtifact(`${prefix}/void`, 'xml', Buffer.from(signed.xml), 'application/xml');
    try {
      const response = await sendToBeta(
        betaOperationEnvelope(
          identity.issuerRuc,
          'sendSummary',
          `<fileName>${xmlEscape(built.file)}.zip</fileName><contentFile>${zip.toString('base64')}</contentFile>`,
        ),
        'sendSummary',
      );
      await this.putArtifact(
        `${prefix}/void-response`,
        'xml',
        Buffer.from(response.body),
        'application/xml',
      );
      const ticket = parseBetaTicket(response.body);
      await this.putJson(`${prefix}/void-ticket.json`, { ticket });
      return { status: 'pending', providerTrackingId: `void:${ticket}` };
    } catch {
      throw new SunatSubmissionAmbiguousError('void:unconfirmed');
    }
  }
  private async reconcileVoid(
    identity: FiscalDocumentIdentity,
    credentials: IssuerCredentialHandle,
    ticket: string,
  ): Promise<SunatReconciliationOutcome> {
    const prefix = this.prefix(identity, credentials);
    const confirmed = await this.readJson<SunatVoidOutcome>(`${prefix}/void-receipt.json`);
    if (confirmed) return confirmed;
    const stored = await this.readJson<{ ticket: string }>(`${prefix}/void-ticket.json`);
    const intent = await this.readJson<{ id: string; file: string; organizationId: string }>(
      `${prefix}/void-intent.json`,
    );
    if (!stored || !intent) return { status: 'pending', providerTrackingId: `void:${ticket}` };
    const response = await sendToBeta(
      betaOperationEnvelope(
        identity.issuerRuc,
        'getStatus',
        `<ticket>${xmlEscape(stored.ticket)}</ticket>`,
      ),
      'getStatus',
    );
    const parsed = parseBetaStatus(response.body, intent.id, intent.file);
    if (parsed.status === 'pending')
      return { status: 'pending', providerTrackingId: `void:${stored.ticket}` };
    if (!parsed.cdrZip || parsed.status === 'soap_fault')
      throw new SunatSubmissionAmbiguousError(`void:${stored.ticket}`);
    const cdr = await this.putArtifact(
      `sunat/${intent.organizationId}/${credentials.issuerId}/documents/${identity.documentId}`,
      'void-cdr',
      parsed.cdrZip,
      'application/zip',
    );
    const outcome: SunatVoidOutcome =
      parsed.status === 'accepted_beta'
        ? { status: 'voided', providerTrackingId: `void:${stored.ticket}`, artifacts: [cdr] }
        : {
            status: 'rejected',
            providerTrackingId: `void:${stored.ticket}`,
            responseCode: parsed.responseCode,
            description: parsed.description,
            observations: [],
            cdrReference: cdr.objectKey,
            artifacts: [cdr],
          };
    await this.putJson(`${prefix}/void-receipt.json`, outcome);
    return outcome;
  }
  private async readJson<T = unknown>(key: string): Promise<T | null> {
    try {
      return JSON.parse((await this.storage.get(key)).toString('utf8')) as T;
    } catch (error) {
      if (
        (error as { name?: string }).name === 'NoSuchKey' ||
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      )
        return null;
      throw error;
    }
  }
  private async putJson(key: string, value: unknown): Promise<void> {
    const body = Buffer.from(JSON.stringify(value));
    await this.storage.putImmutable({
      key,
      body,
      sha256: hash(body),
      contentType: 'application/json',
    });
  }
  listReceivedDocuments(): Promise<never> {
    return Promise.reject(
      new SunatUnsafeConfigurationError('Consulta de recibidos beta no implementada.'),
    );
  }
  health(): Promise<{ ready: boolean; provider: string; environment: 'beta'; detail: string }> {
    return Promise.resolve({
      ready: true,
      provider: 'sunat-beta',
      environment: 'beta' as const,
      detail: 'SUNAT beta oficial: facturas, boletas y notas. Sin validez fiscal.',
    });
  }
  private async putArtifact(
    prefix: string,
    kind: 'zip' | 'cdr' | 'xml' | 'void-cdr',
    body: Buffer,
    contentType: string,
  ): Promise<StoredSunatArtifact> {
    const digest = hash(body);
    const objectKey = `${prefix}/${kind}-${digest}.${kind === 'xml' ? 'xml' : 'zip'}`;
    const stored = await this.storage.putImmutable({
      key: objectKey,
      body,
      contentType,
      sha256: digest,
    });
    return { kind, objectKey, sha256: digest, sizeBytes: stored.sizeBytes, contentType };
  }
}
