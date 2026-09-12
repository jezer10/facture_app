import { EnvelopeEncryption } from '@app/platform';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  SunatCredentialUnavailableError,
  SunatPayloadIntegrityError,
} from '../../domain/errors/sunat.error';
import type { IssuerCredentialHandle } from '../../domain/models/sunat-outcome';
import type {
  CertificateCredentials,
  SolCredentials,
  SunatCredentialVaultPort,
} from '../../domain/ports/sunat-credential-vault.port';
import type { IssuerCredentialPort } from '../../domain/ports/issuer-credential.port';
import { IssuerCredentialEntity } from '../../database/entities';

type CredentialKind = 'sol' | 'certificate';

export class TypeOrmIssuerCredentialAdapter
  implements IssuerCredentialPort, SunatCredentialVaultPort
{
  constructor(
    @InjectRepository(IssuerCredentialEntity)
    private readonly repository: Repository<IssuerCredentialEntity>,
    private readonly encryption: EnvelopeEncryption,
  ) {}

  async resolve(issuerId: string): Promise<IssuerCredentialHandle> {
    const credential = await this.repository.findOne({
      where: { issuerId, active: true },
      order: { version: 'DESC' },
    });
    if (!credential) {
      throw new SunatCredentialUnavailableError();
    }
    return {
      issuerId: credential.issuerId,
      credentialVersion: credential.version,
      environment: credential.environment,
      certificateReference: credential.certificateEnvelope
        ? credentialReference(credential, 'certificate')
        : null,
      // A PKCS#12 archive hash is not a certificate fingerprint.
      certificateFingerprint: null,
      solCredentialReference: credentialReference(credential, 'sol'),
    };
  }

  async loadSolCredentials(handle: IssuerCredentialHandle): Promise<SolCredentials> {
    const credential = await this.loadReferencedCredential(
      handle,
      handle.solCredentialReference,
      'sol',
    );
    const plaintext = this.encryption.decrypt(
      credential.solEnvelope,
      encryptionContext(credential, 'sol'),
    );
    try {
      const parsed = parseJsonRecord(plaintext);
      const ruc = requiredSecretText(parsed.ruc);
      const username = requiredSecretText(parsed.username);
      const password = requiredSecretText(parsed.password);
      if (ruc !== credential.issuerRuc) {
        throw new SunatPayloadIntegrityError(
          'Las credenciales SOL no pertenecen al RUC emisor configurado.',
        );
      }
      return { ruc, username, password };
    } finally {
      plaintext.fill(0);
    }
  }

  async loadCertificate(handle: IssuerCredentialHandle): Promise<CertificateCredentials> {
    const credential = await this.loadReferencedCredential(
      handle,
      handle.certificateReference,
      'certificate',
    );
    if (!credential.certificateEnvelope) {
      throw new SunatCredentialUnavailableError(
        'El emisor no tiene certificado PKCS#12 configurado.',
      );
    }
    const plaintext = this.encryption.decrypt(
      credential.certificateEnvelope,
      encryptionContext(credential, 'certificate'),
    );
    try {
      const parsed = parseJsonRecord(plaintext);
      const base64 = requiredSecretText(parsed.pkcs12Base64);
      const password = requiredSecretText(parsed.password);
      const pkcs12 = decodeCanonicalBase64(base64);
      return { pkcs12, password };
    } finally {
      plaintext.fill(0);
    }
  }

  async readiness(): Promise<{
    ready: boolean;
    durable: true;
    detail?: string;
  }> {
    try {
      await this.repository.query('SELECT 1');
      return { ready: true, durable: true };
    } catch {
      return {
        ready: false,
        durable: true,
        detail: 'No se puede leer el almacén cifrado de credenciales SUNAT.',
      };
    }
  }

  private async loadReferencedCredential(
    handle: IssuerCredentialHandle,
    reference: string | null,
    expectedKind: CredentialKind,
  ): Promise<IssuerCredentialEntity> {
    const parsed = parseCredentialReference(reference, expectedKind);
    const credential = await this.repository.findOneBy({
      id: parsed.id,
      issuerId: handle.issuerId,
      version: handle.credentialVersion,
      active: true,
    });
    if (!credential || credential.version !== parsed.version) {
      throw new SunatCredentialUnavailableError(
        'La versión de credenciales SUNAT ya no está activa.',
      );
    }
    return credential;
  }
}

function credentialReference(credential: IssuerCredentialEntity, kind: CredentialKind): string {
  return `billing-sunat-credential://${credential.id}/${credential.version}/${kind}`;
}

function parseCredentialReference(
  reference: string | null,
  expectedKind: CredentialKind,
): { id: string; version: number } {
  const match = /^billing-sunat-credential:\/\/([0-9a-f-]{36})\/(\d+)\/(sol|certificate)$/iu.exec(
    reference ?? '',
  );
  if (!match || match[3] !== expectedKind) {
    throw new SunatCredentialUnavailableError(
      'La referencia interna de credenciales SUNAT no es válida.',
    );
  }
  return { id: match[1]!, version: Number(match[2]) };
}

function encryptionContext(
  credential: Pick<IssuerCredentialEntity, 'issuerId' | 'version'>,
  kind: CredentialKind,
): string {
  return `sunat:issuer:${credential.issuerId}:version:${credential.version}:${kind}`;
}

function parseJsonRecord(value: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new SunatPayloadIntegrityError(
      'El sobre cifrado de credenciales contiene datos inválidos.',
    );
  }
}

function requiredSecretText(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new SunatPayloadIntegrityError(
      'El sobre cifrado no contiene todos los campos requeridos.',
    );
  }
  return value;
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (
    !decoded.length ||
    decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')
  ) {
    throw new SunatPayloadIntegrityError(
      'El certificado cifrado no contiene PKCS#12 en base64 válido.',
    );
  }
  return decoded;
}

export const issuerCredentialEncryptionContext = encryptionContext;
