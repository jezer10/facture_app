import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { SUNAT_COMMANDS_QUEUE, SUNAT_RESULTS_QUEUE } from '@app/contracts';
import {
  ISSUER_CREDENTIAL_PORT,
  type IssuerCredentialPort,
  SUNAT_ARTIFACT_STORE_PORT,
  SUNAT_COMMAND_LEDGER_PORT,
  SUNAT_PAYLOAD_STORE_PORT,
  SUNAT_PROVIDER_PORT,
  SUNAT_SUBMISSION_JOURNAL_PORT,
  type SunatArtifactStorePort,
  type SunatCommandLedgerPort,
  type SunatPayloadStorePort,
  type SunatProviderPort,
  type SunatSubmissionJournalPort,
  type XmlSignerPort,
  XML_SIGNER_PORT,
} from '@app/sunat';

export interface SunatReadinessReport {
  status: 'ready' | 'not_ready';
  service: 'sunat-service';
  productionCapable: boolean;
  checks: {
    provider: { ready: boolean; detail?: string };
    signer: { ready: boolean; detail?: string };
    credentials: { ready: boolean; detail?: string };
    payloadStore: { ready: boolean; detail?: string };
    artifactStore: { ready: boolean; detail?: string };
    commandLedger: { ready: boolean; detail?: string };
    submissionJournal: { ready: boolean; detail?: string };
    queues: { ready: boolean; detail?: string };
  };
}

@Injectable()
export class SunatHealthService {
  constructor(
    @Inject(SUNAT_PROVIDER_PORT)
    private readonly provider: SunatProviderPort,
    @Inject(XML_SIGNER_PORT)
    private readonly signer: XmlSignerPort,
    @Inject(ISSUER_CREDENTIAL_PORT)
    private readonly credentials: IssuerCredentialPort,
    @Inject(SUNAT_PAYLOAD_STORE_PORT)
    private readonly payloadStore: SunatPayloadStorePort,
    @Inject(SUNAT_ARTIFACT_STORE_PORT)
    private readonly artifactStore: SunatArtifactStorePort,
    @Inject(SUNAT_COMMAND_LEDGER_PORT)
    private readonly ledger: SunatCommandLedgerPort,
    @Inject(SUNAT_SUBMISSION_JOURNAL_PORT)
    private readonly submissionJournal: SunatSubmissionJournalPort,
    @InjectQueue(SUNAT_COMMANDS_QUEUE)
    private readonly commandQueue: Queue,
    @InjectQueue(SUNAT_RESULTS_QUEUE)
    private readonly resultQueue: Queue,
  ) {}

  async readiness(): Promise<SunatReadinessReport> {
    const [provider, credentials, payloadStore, artifactStore, ledger, submissionJournal, queues] =
      await Promise.all([
        this.provider.health(),
        this.credentials.readiness(),
        this.payloadStore.readiness(),
        this.artifactStore.readiness(),
        this.ledger.readiness(),
        this.submissionJournal.readiness(),
        this.queueReadiness(),
      ]);
    const signer = this.signer.readiness();
    const productionCapable =
      provider.environment !== 'mock' &&
      signer.mode === 'signed' &&
      credentials.durable &&
      payloadStore.durable &&
      artifactStore.durable &&
      ledger.durable &&
      submissionJournal.durable;
    const checks = {
      provider: { ready: provider.ready, detail: provider.detail },
      signer: { ready: signer.ready, detail: signer.detail },
      credentials: { ready: credentials.ready, detail: credentials.detail },
      payloadStore: { ready: payloadStore.ready, detail: payloadStore.detail },
      artifactStore: { ready: artifactStore.ready, detail: artifactStore.detail },
      commandLedger: { ready: ledger.ready, detail: ledger.detail },
      submissionJournal: {
        ready: submissionJournal.ready,
        detail: submissionJournal.detail,
      },
      queues,
    };

    return {
      status: Object.values(checks).every((check) => check.ready) ? 'ready' : 'not_ready',
      service: 'sunat-service',
      productionCapable,
      checks,
    };
  }

  private async queueReadiness(): Promise<{ ready: boolean; detail?: string }> {
    try {
      await Promise.all([
        this.commandQueue.getJobCounts('waiting'),
        this.resultQueue.getJobCounts('waiting'),
      ]);
      return { ready: true };
    } catch {
      return {
        ready: false,
        detail: 'Redis/BullMQ no está disponible.',
      };
    }
  }
}
