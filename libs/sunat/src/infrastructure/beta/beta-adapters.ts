import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import type { ObjectStoragePort } from '@app/platform';
import { readSecretFile } from '@app/platform';
import {
  buildBetaInvoice,
  signBetaInvoice,
  verifySignature,
  packageInvoice,
  betaEnvelope,
  sendToBeta,
  parseBetaResponse,
} from './protocol.cjs';
import {
  SunatSubmissionAmbiguousError,
  SunatUnsafeConfigurationError,
  SunatValidationError,
} from '../../domain/errors/sunat.error';
import {
  toFiscalDocumentIdentity,
  type FiscalDocumentSnapshot,
  type FiscalDocumentIdentity,
} from '../../domain/models/fiscal-document';
import type {
  IssuerCredentialHandle,
  SignedUblDocument,
  UnsignedUblDocument,
  SunatSubmissionOutcome,
  SunatReconciliationOutcome,
} from '../../domain/models/sunat-outcome';
import type { UblBuilderPort } from '../../domain/ports/ubl-builder.port';
import type { XmlSignerPort } from '../../domain/ports/xml-signer.port';
import type { IssuerCredentialPort } from '../../domain/ports/issuer-credential.port';
import type { SunatProviderPort } from '../../domain/ports/sunat-provider.port';
import type { StoredSunatArtifact } from '../../domain/ports/sunat-artifact-store.port';

export function assertBetaOnly(): void {
  if (process.env.NODE_ENV === 'production' || process.env.SUNAT_PROVIDER_MODE !== 'beta') {
    throw new SunatUnsafeConfigurationError(
      'Los adaptadores beta requieren desarrollo y SUNAT_PROVIDER_MODE=beta.',
    );
  }
}
const hash = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex');

export class BetaUblBuilder implements UblBuilderPort {
  constructor(private readonly issuerRuc: string) {
    assertBetaOnly();
  }
  build(snapshot: FiscalDocumentSnapshot): UnsignedUblDocument {
    const line = snapshot.lines[0];
    if (
      snapshot.issuer.documentNumber !== this.issuerRuc ||
      snapshot.documentType !== '01' ||
      snapshot.currencyCode !== 'PEN' ||
      snapshot.lines.length !== 1 ||
      !line ||
      snapshot.issuer.documentType !== '6' ||
      snapshot.recipient.documentType !== '6' ||
      !new Decimal(line.quantity).equals(1) ||
      line.tax.schemeId !== '1000' ||
      !new Decimal(line.unitPrice).equals(line.lineExtensionAmount)
    ) {
      throw new SunatValidationError(
        'BETA_UNSUPPORTED_INVOICE',
        'Beta admite sólo una factura PEN del RUC configurado, una línea gravada, cantidad 1, sin descuentos y cliente con RUC.',
      );
    }
    const tax = new Decimal(line.lineExtensionAmount).mul('0.18').toDecimalPlaces(2);
    if (
      !tax.equals(line.tax.taxAmount) ||
      !tax.equals(snapshot.taxTotal) ||
      !new Decimal(line.lineExtensionAmount).equals(line.tax.taxableAmount) ||
      !new Decimal(line.lineExtensionAmount).equals(snapshot.lineExtensionTotal) ||
      !new Decimal(snapshot.lineExtensionTotal).plus(tax).equals(snapshot.payableTotal)
    ) {
      throw new SunatValidationError(
        'BETA_TOTAL_MISMATCH',
        'Los importes no coinciden con la factura beta gravada al 18%.',
      );
    }
    let built;
    try {
      built = buildBetaInvoice({
        environment: 'beta',
        issuer: { ruc: snapshot.issuer.documentNumber, legalName: snapshot.issuer.legalName },
        customer: {
          ruc: snapshot.recipient.documentNumber,
          legalName: snapshot.recipient.legalName,
        },
        series: snapshot.series,
        number: snapshot.number,
        issueDate: snapshot.issueDate,
        description: line.description,
        netAmount: new Decimal(line.unitPrice).toFixed(2),
      });
    } catch {
      throw new SunatValidationError(
        'BETA_INVALID_INPUT',
        'Datos fuera del alcance beta: RUC válido, serie F, valor neto máximo S/500.',
      );
    }
    // Keep the unit selected in the API in the XML sent to SUNAT.
    const xml = built.xml.replace(
      'unitCode="ZZ"',
      `unitCode="${line.unitCode.replace(/[^A-Z0-9]/gu, '')}"`,
    );
    return { identity: toFiscalDocumentIdentity(snapshot), xml, sha256: hash(xml) };
  }
}

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
    _tracking: string | null,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatReconciliationOutcome> {
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
    const outcome = await this.receipt(this.prefix(identity, credentials));
    return outcome && outcome.status !== 'pending' ? (outcome.artifacts ?? []) : [];
  }
  submitVoidCommunication(): Promise<never> {
    return Promise.reject(new SunatUnsafeConfigurationError('Bajas beta aún no implementadas.'));
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
      detail: 'SUNAT beta oficial. Sólo factura simple; no habilita producción.',
    });
  }
  private async putArtifact(
    prefix: string,
    kind: 'zip' | 'cdr' | 'xml',
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
