import {
  EnvelopeEncryption,
  OBJECT_STORAGE_PORT,
  ObjectStorageModule,
  parseEnvironment,
  readSecretFile,
  type ObjectStoragePort,
} from '@app/platform';
import { DynamicModule, Module } from '@nestjs/common';
import type { FactoryProvider } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  type CompletedSunatCommand,
  SunatCommandExecutor,
} from './application/sunat-command-executor';
import { SunatUnsafeConfigurationError } from './domain/errors/sunat.error';
import {
  SUNAT_ARTIFACT_STORE_PORT,
  type SunatArtifactStorePort,
} from './domain/ports/sunat-artifact-store.port';
import {
  SUNAT_COMMAND_LEDGER_PORT,
  type SunatCommandLedgerPort,
} from './domain/ports/command-ledger.port';
import {
  ISSUER_CREDENTIAL_PORT,
  type IssuerCredentialPort,
} from './domain/ports/issuer-credential.port';
import { SUNAT_CREDENTIAL_VAULT_PORT } from './domain/ports/sunat-credential-vault.port';
import {
  SUNAT_PAYLOAD_STORE_PORT,
  type SunatPayloadStorePort,
} from './domain/ports/sunat-payload-store.port';
import { SUNAT_PROVIDER_PORT, type SunatProviderPort } from './domain/ports/sunat-provider.port';
import { UBL_BUILDER_PORT, type UblBuilderPort } from './domain/ports/ubl-builder.port';
import { XML_SIGNER_PORT, type XmlSignerPort } from './domain/ports/xml-signer.port';
import { SunatDatabaseModule } from './database/sunat-database.module';
import { IssuerCredentialEntity } from './database/entities';
import {
  DirectSunatProviderAdapter,
  OFFICIAL_SUNAT_ENDPOINTS,
} from './infrastructure/direct/direct-sunat-provider.adapter';
import {
  SUNAT_SUBMISSION_JOURNAL_PORT,
  type SunatSubmissionJournalPort,
} from './domain/ports/submission-journal.port';
import { TypeOrmCommandLedgerAdapter } from './infrastructure/persistence/typeorm-command-ledger.adapter';
import { TypeOrmIssuerCredentialAdapter } from './infrastructure/persistence/typeorm-issuer-credential.adapter';
import { TypeOrmSubmissionJournalAdapter } from './infrastructure/persistence/typeorm-submission-journal.adapter';
import { UnverifiedPkcs12XmlSignerAdapter } from './infrastructure/signing/unverified-pkcs12-xml-signer.adapter';
import { R2SunatStoreAdapter } from './infrastructure/storage/r2-sunat-store.adapter';
import { DeterministicUblBuilder } from './infrastructure/ubl/deterministic-ubl-builder';
import {
  BetaCredentials,
  BetaSigner,
  BetaSunatProvider,
  BetaUblBuilder,
  assertBetaOnly,
} from './infrastructure/beta/beta-adapters';
import { InternalServiceAuthGuard } from './provisioning/internal-service-auth.guard';
import { IssuerCredentialController } from './provisioning/issuer-credential.controller';
import { IssuerCredentialProvisioningService } from './provisioning/issuer-credential-provisioning.service';
import {
  SUNAT_ENVELOPE_ENCRYPTION,
  SUNAT_INTERNAL_SERVICE_SECRET,
} from './provisioning/provisioning.tokens';

@Module({})
export class SunatModule {
  static forBeta(): DynamicModule {
    assertBetaOnly();
    const env = parseEnvironment(process.env);
    if (!env.SUNAT_BETA_KEY_FILE || !env.SUNAT_BETA_CERT_FILE) {
      throw new SunatUnsafeConfigurationError('Configura el certificado de prueba de Sandbox.');
    }
    const persistent = this.forProduction();
    return {
      ...persistent,
      providers: [
        ...persistent.providers!,
        {
          provide: BetaSigner,
          useFactory: () => new BetaSigner(env.SUNAT_BETA_KEY_FILE!, env.SUNAT_BETA_CERT_FILE!),
        },
        { provide: XML_SIGNER_PORT, useExisting: BetaSigner },
        { provide: ISSUER_CREDENTIAL_PORT, useFactory: () => new BetaCredentials() },
        {
          provide: UBL_BUILDER_PORT,
          useFactory: () => new BetaUblBuilder(),
        },
        {
          provide: SUNAT_PROVIDER_PORT,
          inject: [OBJECT_STORAGE_PORT, BetaSigner, DataSource],
          useFactory: (storage: ObjectStoragePort, signer: BetaSigner, database: DataSource) =>
            new BetaSunatProvider(storage, signer, database),
        },
      ],
    };
  }
  static forProduction(): DynamicModule {
    return {
      module: SunatModule,
      imports: [SunatDatabaseModule, ObjectStorageModule],
      controllers: [IssuerCredentialController],
      providers: [
        {
          provide: SUNAT_ENVELOPE_ENCRYPTION,
          useFactory: productionEnvelopeEncryption,
        },
        {
          provide: SUNAT_INTERNAL_SERVICE_SECRET,
          useFactory: internalServiceSecret,
        },
        {
          provide: R2SunatStoreAdapter,
          inject: [OBJECT_STORAGE_PORT],
          useFactory: (storage: ObjectStoragePort) => new R2SunatStoreAdapter(storage),
        },
        { provide: SUNAT_PAYLOAD_STORE_PORT, useExisting: R2SunatStoreAdapter },
        { provide: SUNAT_ARTIFACT_STORE_PORT, useExisting: R2SunatStoreAdapter },
        {
          provide: TypeOrmCommandLedgerAdapter,
          inject: [DataSource],
          useFactory: (dataSource: DataSource) => new TypeOrmCommandLedgerAdapter(dataSource),
        },
        { provide: SUNAT_COMMAND_LEDGER_PORT, useExisting: TypeOrmCommandLedgerAdapter },
        {
          provide: TypeOrmSubmissionJournalAdapter,
          inject: [DataSource],
          useFactory: (dataSource: DataSource) => new TypeOrmSubmissionJournalAdapter(dataSource),
        },
        {
          provide: SUNAT_SUBMISSION_JOURNAL_PORT,
          useExisting: TypeOrmSubmissionJournalAdapter,
        },
        {
          provide: TypeOrmIssuerCredentialAdapter,
          inject: [DataSource, SUNAT_ENVELOPE_ENCRYPTION],
          useFactory: (dataSource: DataSource, encryption: EnvelopeEncryption) =>
            new TypeOrmIssuerCredentialAdapter(
              dataSource.getRepository(IssuerCredentialEntity),
              encryption,
            ),
        },
        { provide: ISSUER_CREDENTIAL_PORT, useExisting: TypeOrmIssuerCredentialAdapter },
        { provide: SUNAT_CREDENTIAL_VAULT_PORT, useExisting: TypeOrmIssuerCredentialAdapter },
        {
          provide: SUNAT_PROVIDER_PORT,
          useFactory: directSunatProvider,
        },
        { provide: XML_SIGNER_PORT, useClass: UnverifiedPkcs12XmlSignerAdapter },
        { provide: UBL_BUILDER_PORT, useClass: DeterministicUblBuilder },
        {
          provide: IssuerCredentialProvisioningService,
          inject: [DataSource, SUNAT_ENVELOPE_ENCRYPTION],
          useFactory: (dataSource: DataSource, encryption: EnvelopeEncryption) =>
            new IssuerCredentialProvisioningService(dataSource, encryption),
        },
        InternalServiceAuthGuard,
        commandExecutorProvider(),
      ],
      exports: [
        SunatCommandExecutor,
        SUNAT_PROVIDER_PORT,
        XML_SIGNER_PORT,
        ISSUER_CREDENTIAL_PORT,
        SUNAT_CREDENTIAL_VAULT_PORT,
        SUNAT_PAYLOAD_STORE_PORT,
        SUNAT_ARTIFACT_STORE_PORT,
        SUNAT_COMMAND_LEDGER_PORT,
        SUNAT_SUBMISSION_JOURNAL_PORT,
      ],
    };
  }
}

function commandExecutorProvider(): FactoryProvider<SunatCommandExecutor> {
  return {
    provide: SunatCommandExecutor,
    inject: [
      SUNAT_PROVIDER_PORT,
      XML_SIGNER_PORT,
      UBL_BUILDER_PORT,
      ISSUER_CREDENTIAL_PORT,
      SUNAT_PAYLOAD_STORE_PORT,
      SUNAT_ARTIFACT_STORE_PORT,
      SUNAT_COMMAND_LEDGER_PORT,
      SUNAT_SUBMISSION_JOURNAL_PORT,
    ],
    useFactory: (
      provider: SunatProviderPort,
      signer: XmlSignerPort,
      ublBuilder: UblBuilderPort,
      credentials: IssuerCredentialPort,
      payloadStore: SunatPayloadStorePort,
      artifactStore: SunatArtifactStorePort,
      ledger: SunatCommandLedgerPort<CompletedSunatCommand>,
      submissionJournal: SunatSubmissionJournalPort,
    ) =>
      new SunatCommandExecutor({
        provider,
        signer,
        ublBuilder,
        credentials,
        payloadStore,
        artifactStore,
        ledger,
        submissionJournal,
      }),
  };
}

function productionEnvelopeEncryption(): EnvelopeEncryption {
  const path = parseEnvironment(process.env).BILLING_MASTER_KEY_FILE;
  if (!path) {
    throw new SunatUnsafeConfigurationError(
      'BILLING_MASTER_KEY_FILE es obligatorio para credenciales SUNAT cifradas.',
    );
  }
  return new EnvelopeEncryption(readSecretFile(path, 32));
}

function internalServiceSecret(): string {
  const path = parseEnvironment(process.env).SUNAT_INTERNAL_SERVICE_SECRET_FILE;
  if (!path) {
    throw new SunatUnsafeConfigurationError(
      'SUNAT_INTERNAL_SERVICE_SECRET_FILE es obligatorio para provisioning SUNAT.',
    );
  }
  const secret = readSecretFile(path, 32);
  try {
    return secret.toString('base64url');
  } finally {
    secret.fill(0);
  }
}

function directSunatProvider(): DirectSunatProviderAdapter {
  const environment = parseSunatEnvironment(process.env.SUNAT_ENVIRONMENT);
  const defaults =
    environment === 'production'
      ? {
          bill: OFFICIAL_SUNAT_ENDPOINTS.productionBillService,
          consult: OFFICIAL_SUNAT_ENDPOINTS.productionConsultService,
        }
      : {
          bill: OFFICIAL_SUNAT_ENDPOINTS.betaBillService,
          consult: OFFICIAL_SUNAT_ENDPOINTS.betaBillService,
        };
  return new DirectSunatProviderAdapter({
    environment,
    billServiceUrl: process.env.SUNAT_BILL_SERVICE_URL ?? defaults.bill,
    consultServiceUrl: process.env.SUNAT_CONSULT_SERVICE_URL ?? defaults.consult,
    timeoutMs: parseEnvironment(process.env).SUNAT_TIMEOUT_MS,
  });
}

function parseSunatEnvironment(value: string | undefined): 'beta' | 'production' {
  const environment = value?.trim().toLowerCase() ?? 'production';
  if (environment !== 'beta' && environment !== 'production') {
    throw new SunatUnsafeConfigurationError('SUNAT_ENVIRONMENT debe ser beta o production.');
  }
  return environment;
}
