import { sha256 } from '@app/platform';
import { EnvelopeEncryption } from '@app/platform';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SunatValidationError } from '../domain/errors/sunat.error';
import { IssuerCredentialEntity } from '../database/entities';
import { issuerCredentialEncryptionContext } from '../infrastructure/persistence/typeorm-issuer-credential.adapter';

const MAX_CERTIFICATE_BYTES = 2 * 1024 * 1024;

export interface ProvisionIssuerCredentialInput {
  readonly organizationId: string;
  readonly issuerId: string;
  readonly issuerRuc: string;
  readonly environment: 'beta' | 'production';
  readonly solUsername: string;
  readonly solPassword: string;
  readonly certificatePkcs12Base64?: string;
  readonly certificatePassword?: string;
  readonly certificateExpiresAt?: string;
}

export interface IssuerCredentialStatus {
  readonly issuerId: string;
  readonly issuerRuc: string;
  readonly environment: 'beta' | 'production';
  readonly version: number;
  readonly active: boolean;
  readonly hasCertificate: boolean;
  readonly certificateArchiveSha256: string | null;
  readonly certificateExpiresAt: string | null;
  readonly updatedAt: string;
}

@Injectable()
export class IssuerCredentialProvisioningService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EnvelopeEncryption,
  ) {}

  async provision(input: ProvisionIssuerCredentialInput): Promise<IssuerCredentialStatus> {
    validateProvisioningInput(input);
    const certificate = readCertificate(input);
    try {
      return await this.dataSource.transaction(async (manager) => {
        // A transaction-scoped advisory lock serializes first-time and rotation writes.
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `sunat-credential:${input.issuerId}`,
        ]);
        const repository = manager.getRepository(IssuerCredentialEntity);
        const latest = await repository.findOne({
          where: { issuerId: input.issuerId },
          order: { version: 'DESC' },
        });
        const version = (latest?.version ?? 0) + 1;
        await repository.update({ issuerId: input.issuerId, active: true }, { active: false });

        const solPlaintext = Buffer.from(
          JSON.stringify({
            ruc: input.issuerRuc,
            username: input.solUsername.trim(),
            password: input.solPassword,
          }),
          'utf8',
        );
        const certificatePlaintext = certificate
          ? Buffer.from(
              JSON.stringify({
                pkcs12Base64: certificate.body.toString('base64'),
                password: input.certificatePassword,
              }),
              'utf8',
            )
          : null;
        try {
          const context = { issuerId: input.issuerId, version };
          const entity = repository.create({
            organizationId: input.organizationId,
            issuerId: input.issuerId,
            issuerRuc: input.issuerRuc,
            environment: input.environment,
            version,
            solEnvelope: this.encryption.encrypt(
              solPlaintext,
              issuerCredentialEncryptionContext(context, 'sol'),
            ),
            certificateEnvelope: certificatePlaintext
              ? this.encryption.encrypt(
                  certificatePlaintext,
                  issuerCredentialEncryptionContext(context, 'certificate'),
                )
              : null,
            certificateArchiveSha256: certificate ? sha256(certificate.body) : null,
            certificateExpiresAt: input.certificateExpiresAt
              ? new Date(input.certificateExpiresAt)
              : null,
            active: true,
          });
          return toStatus(await repository.save(entity));
        } finally {
          solPlaintext.fill(0);
          certificatePlaintext?.fill(0);
        }
      });
    } finally {
      certificate?.body.fill(0);
    }
  }

  async status(issuerId: string): Promise<IssuerCredentialStatus | null> {
    const credential = await this.dataSource
      .getRepository(IssuerCredentialEntity)
      .findOne({ where: { issuerId, active: true } });
    return credential ? toStatus(credential) : null;
  }
}

function validateProvisioningInput(input: ProvisionIssuerCredentialInput): void {
  if (!isUuid(input.organizationId) || !isUuid(input.issuerId)) {
    throw invalidProvisioning('organizationId e issuerId deben ser UUID válidos.');
  }
  if (!/^\d{11}$/u.test(input.issuerRuc)) {
    throw invalidProvisioning('issuerRuc debe contener 11 dígitos.');
  }
  if (!['beta', 'production'].includes(input.environment)) {
    throw invalidProvisioning('environment debe ser beta o production.');
  }
  if (!input.solUsername.trim() || input.solUsername.length > 100) {
    throw invalidProvisioning('solUsername tiene un formato inválido.');
  }
  if (!input.solPassword || input.solPassword.length > 300) {
    throw invalidProvisioning('solPassword tiene un formato inválido.');
  }
  const hasArchive = input.certificatePkcs12Base64 !== undefined;
  const hasPassword = input.certificatePassword !== undefined;
  if (hasArchive !== hasPassword) {
    throw invalidProvisioning('El certificado PKCS#12 y su contraseña deben enviarse juntos.');
  }
  if ((input.certificatePassword?.length ?? 0) > 300) {
    throw invalidProvisioning('certificatePassword excede 300 caracteres.');
  }
  if (input.certificateExpiresAt) {
    const date = new Date(input.certificateExpiresAt);
    if (Number.isNaN(date.getTime())) {
      throw invalidProvisioning('certificateExpiresAt no es una fecha válida.');
    }
  }
}

function readCertificate(input: ProvisionIssuerCredentialInput): { body: Buffer } | null {
  if (!input.certificatePkcs12Base64) {
    return null;
  }
  if (input.certificatePkcs12Base64.length > 2_800_000) {
    throw invalidProvisioning('certificatePkcs12Base64 excede el tamaño permitido.');
  }
  const body = Buffer.from(input.certificatePkcs12Base64, 'base64');
  const canonical = body.toString('base64').replace(/=+$/u, '');
  if (
    !body.length ||
    canonical !== input.certificatePkcs12Base64.replace(/=+$/u, '') ||
    body.length > MAX_CERTIFICATE_BYTES
  ) {
    body.fill(0);
    throw invalidProvisioning('certificatePkcs12Base64 no es un archivo válido o excede 2 MiB.');
  }
  return { body };
}

function toStatus(entity: IssuerCredentialEntity): IssuerCredentialStatus {
  return {
    issuerId: entity.issuerId,
    issuerRuc: entity.issuerRuc,
    environment: entity.environment,
    version: entity.version,
    active: entity.active,
    hasCertificate: entity.certificateEnvelope !== null,
    certificateArchiveSha256: entity.certificateArchiveSha256,
    certificateExpiresAt: entity.certificateExpiresAt?.toISOString() ?? null,
    updatedAt: entity.updatedAt.toISOString(),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function invalidProvisioning(message: string): SunatValidationError {
  return new SunatValidationError('SUNAT_INVALID_CREDENTIAL_PROVISIONING', message);
}
