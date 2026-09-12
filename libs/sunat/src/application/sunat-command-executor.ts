import { createHash } from 'node:crypto';

import type {
  AcceptedDocumentResultPayload,
  ArtifactReference,
  FailedDocumentResultPayload,
  ReconcileDocumentCommandPayload,
  ReconcilingDocumentResultPayload,
  ReceivedSyncCompletedResultPayload,
  ReceivedSyncFailedResultPayload,
  RejectedDocumentResultPayload,
  SunatCommandEnvelope,
  SunatResultEnvelope,
  VoidedDocumentResultPayload,
} from '@app/contracts';
import { compareCanonicalJsonKeys, sunatDocumentArtifactObjectKey } from '@app/contracts';

import {
  SunatError,
  SunatProviderTransientError,
  SunatSubmissionAmbiguousError,
  SunatValidationError,
  toSafeSunatError,
} from '../domain/errors/sunat.error';
import type {
  FiscalDocumentIdentity,
  FiscalDocumentSnapshot,
} from '../domain/models/fiscal-document';
import { toFiscalDocumentIdentity } from '../domain/models/fiscal-document';
import type {
  IssuerCredentialHandle,
  SunatReconciliationOutcome,
  SunatSubmissionOutcome,
} from '../domain/models/sunat-outcome';
import type {
  StoredSunatArtifact,
  SunatArtifactStorePort,
} from '../domain/ports/sunat-artifact-store.port';
import type { SunatCommandLedgerPort } from '../domain/ports/command-ledger.port';
import type { IssuerCredentialPort } from '../domain/ports/issuer-credential.port';
import type {
  BeginSubmissionResult,
  SubmissionOperation,
  SunatSubmissionJournalPort,
} from '../domain/ports/submission-journal.port';
import type { SunatPayloadStorePort } from '../domain/ports/sunat-payload-store.port';
import type { SunatProviderPort } from '../domain/ports/sunat-provider.port';
import type { UblBuilderPort } from '../domain/ports/ubl-builder.port';
import type { XmlSignerPort } from '../domain/ports/xml-signer.port';
import {
  parseFiscalDocumentSnapshot,
  parseReceivedDocumentSyncRequest,
} from './parse-sunat-payload';

export interface CompletedSunatCommand {
  readonly result: SunatResultEnvelope;
  readonly followUp?: SunatCommandEnvelope;
}

export type SunatCommandDecision =
  | { readonly kind: 'completed'; readonly output: CompletedSunatCommand }
  | {
      readonly kind: 'retry';
      readonly error: SunatError;
      readonly progress?: SunatResultEnvelope;
    };

export interface SunatCommandExecutionContext {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

export interface SunatCommandExecutorDependencies {
  readonly provider: SunatProviderPort;
  readonly signer: XmlSignerPort;
  readonly ublBuilder: UblBuilderPort;
  readonly credentials: IssuerCredentialPort;
  readonly payloadStore: SunatPayloadStorePort;
  readonly artifactStore: SunatArtifactStorePort;
  readonly ledger: SunatCommandLedgerPort<CompletedSunatCommand>;
  readonly submissionJournal: SunatSubmissionJournalPort;
  readonly now?: () => Date;
}

export class SunatCommandExecutor {
  private readonly now: () => Date;

  constructor(private readonly dependencies: SunatCommandExecutorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(
    command: SunatCommandEnvelope,
    context: SunatCommandExecutionContext,
  ): Promise<SunatCommandDecision> {
    assertReservableCommand(command);
    const reservation = await this.dependencies.ledger.reserve(command.eventId, context.attempt);
    if (reservation.state === 'completed') {
      return { kind: 'completed', output: reservation.result };
    }
    if (reservation.state === 'processing') {
      return {
        kind: 'retry',
        error: new SunatProviderTransientError(
          'SUNAT_COMMAND_ALREADY_PROCESSING',
          'El comando SUNAT ya está siendo procesado.',
        ),
      };
    }

    try {
      assertSafeCommand(command);
      const output = await this.dispatch(command, context);
      await this.dependencies.ledger.complete(command.eventId, output);
      return { kind: 'completed', output };
    } catch (error) {
      const safeError = toSafeSunatError(error);
      if (safeError.retryable && !isFinalAttempt(context)) {
        await this.dependencies.ledger.release(command.eventId);
        return { kind: 'retry', error: safeError };
      }
      return this.completeFailure(command, terminalError(safeError));
    }
  }

  private async dispatch(
    command: SunatCommandEnvelope,
    context: SunatCommandExecutionContext,
  ): Promise<CompletedSunatCommand> {
    switch (command.type) {
      case 'sunat.document.issue.requested.v1':
        return this.issueDocument(command, context);
      case 'sunat.document.void.requested.v1':
        return this.voidDocument(command, context);
      case 'sunat.received.sync.requested.v1':
        return this.syncReceivedDocuments(command);
      case 'sunat.document.reconcile.requested.v1':
        return this.reconcileDocument(command, context);
    }
  }

  private async voidDocument(
    command: Extract<SunatCommandEnvelope, { type: 'sunat.document.void.requested.v1' }>,
    context: SunatCommandExecutionContext,
  ): Promise<CompletedSunatCommand> {
    const payload = await this.dependencies.payloadStore.load(
      command.payloadRef,
      command.payloadSha256,
    );
    const snapshot = parseFiscalDocumentSnapshot(payload, {
      documentId: command.payload.documentId,
    });
    assertDocumentSummaryMatches(command.payload, snapshot);
    if (!command.payload.reason.trim()) {
      throw new SunatValidationError(
        'SUNAT_VOID_REASON_REQUIRED',
        'La comunicación de baja requiere un motivo.',
      );
    }
    const credentials = await this.dependencies.credentials.resolve(command.issuerId);
    const identity = toFiscalDocumentIdentity(snapshot);
    const submission = await this.beginSubmission(command, identity, 'void');
    const existingOutput = await this.existingSubmissionOutput(
      command,
      snapshot,
      submission,
      [],
      context,
    );
    if (existingOutput) {
      return existingOutput;
    }
    const startedAt = this.now();
    try {
      const outcome = await this.dependencies.provider.submitVoidCommunication(
        identity,
        command.payload.reason,
        credentials,
      );
      await this.recordSubmissionOutcome(
        submission.submissionId,
        context.attempt,
        'sunat-provider:sendSummary',
        startedAt,
        outcome,
      );
      if (outcome.status === 'pending') {
        return this.reconcilingOutput(
          command,
          snapshot,
          outcome.providerTrackingId ?? localSubmissionId(toFiscalDocumentIdentity(snapshot)),
          outcome.providerTrackingId ?? undefined,
          context,
        );
      }
      if (outcome.status === 'rejected') {
        const rejected: RejectedDocumentResultPayload = {
          documentId: snapshot.documentId,
          submissionId:
            outcome.providerTrackingId ?? localSubmissionId(toFiscalDocumentIdentity(snapshot)),
          code: outcome.responseCode,
          description: outcome.description,
          artifacts: [],
        };
        return {
          result: await this.buildResultEnvelope(command, 'sunat.document.rejected.v1', rejected),
        };
      }
      return this.voidedOutput(command, snapshot.documentId, outcome.providerTrackingId);
    } catch (error) {
      if (!(error instanceof SunatSubmissionAmbiguousError)) {
        await this.recordSubmissionFailure(
          submission.submissionId,
          context.attempt,
          'sunat-provider:sendSummary',
          startedAt,
          error,
        );
        throw error;
      }
      await this.recordAmbiguousSubmission(
        submission.submissionId,
        context.attempt,
        'sunat-provider:sendSummary',
        startedAt,
        error.trackingId,
      );
      return this.reconcilingOutput(
        command,
        snapshot,
        error.trackingId ?? localSubmissionId(toFiscalDocumentIdentity(snapshot)),
        error.trackingId ?? undefined,
        context,
      );
    }
  }

  private async issueDocument(
    command: Extract<SunatCommandEnvelope, { type: 'sunat.document.issue.requested.v1' }>,
    context: SunatCommandExecutionContext,
  ): Promise<CompletedSunatCommand> {
    const payload = await this.dependencies.payloadStore.load(
      command.payloadRef,
      command.payloadSha256,
    );
    const snapshot = parseFiscalDocumentSnapshot(payload, {
      documentId: command.payload.documentId,
    });
    assertIssueSummaryMatches(command.payload, snapshot);
    const credentials = await this.dependencies.credentials.resolve(command.issuerId);
    const unsignedDocument = this.dependencies.ublBuilder.build(snapshot);
    const xmlArtifact = await this.storeXml(command, unsignedDocument.xml, 'xml');
    const signedDocument = await this.dependencies.signer.sign(unsignedDocument, credentials);
    const signedArtifact =
      signedDocument.signature.state === 'signed'
        ? await this.storeXml(command, signedDocument.xml, 'signed-xml')
        : null;
    const identity = toFiscalDocumentIdentity(snapshot);
    const submission = await this.beginSubmission(command, identity, 'issue');
    const artifacts = compactArtifacts([xmlArtifact, signedArtifact]);
    const existingOutput = await this.existingSubmissionOutput(
      command,
      snapshot,
      submission,
      artifacts,
      context,
    );
    if (existingOutput) {
      return existingOutput;
    }
    const startedAt = this.now();

    try {
      const outcome = await this.dependencies.provider.submitDocument(signedDocument, credentials);
      await this.recordSubmissionOutcome(
        submission.submissionId,
        context.attempt,
        'sunat-provider:sendBill',
        startedAt,
        outcome,
      );
      return this.submissionOutput(command, snapshot, credentials, outcome, artifacts, context);
    } catch (error) {
      if (!(error instanceof SunatSubmissionAmbiguousError)) {
        await this.recordSubmissionFailure(
          submission.submissionId,
          context.attempt,
          'sunat-provider:sendBill',
          startedAt,
          error,
        );
        throw error;
      }

      await this.recordAmbiguousSubmission(
        submission.submissionId,
        context.attempt,
        'sunat-provider:sendBill',
        startedAt,
        error.trackingId,
      );

      return this.reconcilingOutput(
        command,
        snapshot,
        error.trackingId ?? localSubmissionId(toFiscalDocumentIdentity(snapshot)),
        error.trackingId ?? undefined,
        context,
      );
    }
  }

  private async reconcileDocument(
    command: Extract<SunatCommandEnvelope, { type: 'sunat.document.reconcile.requested.v1' }>,
    context: SunatCommandExecutionContext,
  ): Promise<CompletedSunatCommand> {
    const payload = await this.dependencies.payloadStore.load(
      command.payloadRef,
      command.payloadSha256,
    );
    const snapshot = parseFiscalDocumentSnapshot(payload, {
      documentId: command.payload.documentId,
    });
    if (snapshot.documentId !== command.payload.documentId) {
      throw new SunatValidationError(
        'SUNAT_RECONCILIATION_IDENTITY_MISMATCH',
        'El documento a conciliar no coincide con el snapshot fiscal.',
      );
    }
    const credentials = await this.dependencies.credentials.resolve(command.issuerId);
    const identity = toFiscalDocumentIdentity(snapshot);
    const submission = await this.dependencies.submissionJournal.findForReconciliation({
      issuerId: command.issuerId,
      identity,
      providerTrackingId: command.payload.submissionId,
      ...(command.payload.ticket ? { ticket: command.payload.ticket } : {}),
    });
    const startedAt = this.now();
    let outcome: SunatReconciliationOutcome;
    try {
      outcome = await this.dependencies.provider.reconcileDocument(
        identity,
        command.payload.ticket ?? command.payload.submissionId,
        credentials,
      );
    } catch (error) {
      if (submission) {
        await this.recordSubmissionFailure(
          submission.submissionId,
          reconciliationAttempt(context.attempt),
          'sunat-provider:getStatus',
          startedAt,
          error,
        );
      }
      throw error;
    }

    if (submission) {
      await this.recordReconciliationOutcome(
        submission.submissionId,
        reconciliationAttempt(context.attempt),
        startedAt,
        outcome,
        command.payload.ticket,
      );
    }

    if (outcome.status === 'pending' || outcome.status === 'not_found') {
      if (isFinalAttempt(context)) {
        throw new SunatError({
          category: 'submission_ambiguous',
          code: 'SUNAT_RECONCILIATION_EXHAUSTED',
          message:
            'SUNAT no confirmó el envío después de agotar la conciliación; requiere revisión manual.',
        });
      }
      throw new SunatProviderTransientError(
        'SUNAT_RECONCILIATION_PENDING',
        'El estado del envío aún no está disponible en SUNAT.',
      );
    }

    return this.reconciledSubmissionOutput(command, snapshot, outcome);
  }

  private async syncReceivedDocuments(
    command: Extract<SunatCommandEnvelope, { type: 'sunat.received.sync.requested.v1' }>,
  ): Promise<CompletedSunatCommand> {
    const payload = await this.dependencies.payloadStore.load(
      command.payloadRef,
      command.payloadSha256,
    );
    const request = parseReceivedDocumentSyncRequest(payload);
    assertSyncSummaryMatches(command.payload, request);
    const credentials = await this.dependencies.credentials.resolve(command.issuerId);
    const outcome = await this.dependencies.provider.listReceivedDocuments(request, credentials);
    await Promise.all(
      request.documentTypes.map((documentType) =>
        this.dependencies.submissionJournal.updateReceivedSyncCursor({
          issuerId: command.issuerId,
          documentType,
          source: request.source ?? '2',
          lastIssueDate: request.dateTo,
          providerCursor: outcome.sourceCursor,
          syncedAt: this.now(),
        }),
      ),
    );
    const records = await this.storeJsonArtifact(
      `sunat/received-sync/${safePathPart(command.organizationId)}/${safePathPart(command.issuerId)}/${safePathPart(request.syncId)}/records.json`,
      outcome.documents,
    );
    const resultPayload: ReceivedSyncCompletedResultPayload = {
      syncId: request.syncId,
      importedCount: outcome.documents.length,
      skippedCount: 0,
      failedCount: 0,
      recordsRef: records.objectKey,
      recordsSha256: records.sha256,
    };
    return {
      result: await this.buildResultEnvelope(
        command,
        'sunat.received.sync.completed.v1',
        resultPayload,
      ),
    };
  }

  private async submissionOutput(
    command: Extract<SunatCommandEnvelope, { type: 'sunat.document.issue.requested.v1' }>,
    snapshot: FiscalDocumentSnapshot,
    _credentials: IssuerCredentialHandle,
    outcome: SunatSubmissionOutcome,
    artifacts: readonly ArtifactReference[],
    context: SunatCommandExecutionContext,
  ): Promise<CompletedSunatCommand> {
    if (outcome.status === 'pending') {
      const submissionId =
        outcome.providerTrackingId ?? localSubmissionId(toFiscalDocumentIdentity(snapshot));
      return this.reconcilingOutput(
        command,
        snapshot,
        submissionId,
        outcome.providerTrackingId ?? undefined,
        context,
      );
    }
    if (outcome.status === 'rejected') {
      const resultPayload: RejectedDocumentResultPayload = {
        documentId: snapshot.documentId,
        submissionId:
          outcome.providerTrackingId ?? localSubmissionId(toFiscalDocumentIdentity(snapshot)),
        code: outcome.responseCode,
        description: outcome.description,
        artifacts,
      };
      return {
        result: await this.buildResultEnvelope(
          command,
          'sunat.document.rejected.v1',
          resultPayload,
        ),
      };
    }

    const resultPayload: AcceptedDocumentResultPayload = {
      documentId: snapshot.documentId,
      submissionId: outcome.providerTrackingId,
      acceptedAt: this.now().toISOString(),
      observationCodes: outcome.observations,
      artifacts,
    };
    return {
      result: await this.buildResultEnvelope(command, 'sunat.document.accepted.v1', resultPayload),
    };
  }

  private async reconciledSubmissionOutput(
    command: Extract<SunatCommandEnvelope, { type: 'sunat.document.reconcile.requested.v1' }>,
    snapshot: FiscalDocumentSnapshot,
    outcome: Exclude<SunatReconciliationOutcome, { status: 'pending' | 'not_found' }>,
  ): Promise<CompletedSunatCommand> {
    const submissionId = outcome.providerTrackingId ?? command.payload.submissionId;
    if (outcome.status === 'voided') {
      return this.voidedOutput(command, snapshot.documentId, submissionId);
    }
    if (outcome.status === 'rejected') {
      const payload: RejectedDocumentResultPayload = {
        documentId: snapshot.documentId,
        submissionId,
        code: outcome.responseCode,
        description: outcome.description,
        artifacts: [],
      };
      return {
        result: await this.buildResultEnvelope(command, 'sunat.document.rejected.v1', payload),
      };
    }
    const payload: AcceptedDocumentResultPayload = {
      documentId: snapshot.documentId,
      submissionId,
      acceptedAt: this.now().toISOString(),
      observationCodes: outcome.observations,
      artifacts: [],
    };
    return {
      result: await this.buildResultEnvelope(command, 'sunat.document.accepted.v1', payload),
    };
  }

  private async reconcilingOutput(
    command: Extract<
      SunatCommandEnvelope,
      {
        type: 'sunat.document.issue.requested.v1' | 'sunat.document.void.requested.v1';
      }
    >,
    snapshot: FiscalDocumentSnapshot,
    submissionId: string,
    ticket: string | undefined,
    context: SunatCommandExecutionContext,
  ): Promise<CompletedSunatCommand> {
    const nextCheckAt = new Date(this.now().getTime() + context.retryDelayMs).toISOString();
    const payload: ReconcilingDocumentResultPayload = {
      documentId: snapshot.documentId,
      submissionId,
      ...(ticket ? { ticket } : {}),
      nextCheckAt,
    };
    const followUpPayload: ReconcileDocumentCommandPayload = {
      documentId: snapshot.documentId,
      submissionId,
      ...(ticket ? { ticket } : {}),
    };
    const followUp: SunatCommandEnvelope = {
      eventId: deterministicId(`${command.eventId}:reconcile:${submissionId}`),
      type: 'sunat.document.reconcile.requested.v1',
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId: command.correlationId,
      causationId: command.eventId,
      organizationId: command.organizationId,
      issuerId: command.issuerId,
      payloadRef: command.payloadRef,
      payloadSha256: command.payloadSha256,
      payload: followUpPayload,
    };
    return {
      result: await this.buildResultEnvelope(command, 'sunat.document.reconciling.v1', payload),
      followUp,
    };
  }

  private async voidedOutput(
    command: SunatCommandEnvelope,
    documentId: string,
    submissionId: string,
  ): Promise<CompletedSunatCommand> {
    const payload: VoidedDocumentResultPayload = {
      documentId,
      submissionId,
      voidedAt: this.now().toISOString(),
      artifacts: [],
    };
    return {
      result: await this.buildResultEnvelope(command, 'sunat.document.voided.v1', payload),
    };
  }

  private async completeFailure(
    command: SunatCommandEnvelope,
    error: SunatError,
  ): Promise<SunatCommandDecision> {
    let result: SunatResultEnvelope;
    if (command.type === 'sunat.received.sync.requested.v1') {
      const payload: ReceivedSyncFailedResultPayload = {
        syncId: command.payload.syncId,
        code: error.code,
        description: error.message,
        retryable: false,
      };
      result = await this.buildResultEnvelope(command, 'sunat.received.sync.failed.v1', payload);
    } else {
      const payload: FailedDocumentResultPayload = {
        documentId: command.payload.documentId,
        ...(command.type === 'sunat.document.reconcile.requested.v1'
          ? { submissionId: command.payload.submissionId }
          : {}),
        code: error.code,
        description: error.message,
        retryable: false,
      };
      result = await this.buildResultEnvelope(command, 'sunat.document.failed.v1', payload);
    }
    const output: CompletedSunatCommand = {
      result,
    };
    await this.dependencies.ledger.complete(command.eventId, output);
    return { kind: 'completed', output };
  }

  private async buildResultEnvelope<TType extends SunatResultEnvelope['type']>(
    command: SunatCommandEnvelope,
    type: TType,
    payload: Extract<SunatResultEnvelope, { type: TType }>['payload'],
  ): Promise<Extract<SunatResultEnvelope, { type: TType }>> {
    const eventId = deterministicId(`${command.eventId}:${type}`);
    const storedPayload = await this.storeJsonArtifact(
      `sunat/results/${safePathPart(command.organizationId)}/${safePathPart(command.issuerId)}/${eventId}.json`,
      payload,
    );
    return {
      eventId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId: command.correlationId,
      causationId: command.eventId,
      organizationId: command.organizationId,
      issuerId: command.issuerId,
      payloadRef: storedPayload.objectKey,
      payloadSha256: storedPayload.sha256,
      payload,
    } as Extract<SunatResultEnvelope, { type: TType }>;
  }

  private async storeXml(
    command: Extract<SunatCommandEnvelope, { type: 'sunat.document.issue.requested.v1' }>,
    xml: string,
    kind: 'xml' | 'signed-xml',
  ): Promise<ArtifactReference> {
    const body = Buffer.from(xml, 'utf8');
    const sha256 = createHash('sha256').update(body).digest('hex');
    return this.dependencies.artifactStore.store({
      kind,
      objectKey: sunatDocumentArtifactObjectKey({
        organizationId: command.organizationId,
        issuerId: command.issuerId,
        documentId: command.payload.documentId,
        kind,
        sha256,
      }),
      contentType: 'application/xml',
      body,
    });
  }

  private async storeJsonArtifact(objectKey: string, value: unknown): Promise<StoredSunatArtifact> {
    return this.dependencies.artifactStore.store({
      kind: 'canonical-json',
      objectKey,
      contentType: 'application/json',
      body: Buffer.from(`${stableJson(value)}\n`, 'utf8'),
    });
  }

  private beginSubmission(
    command: SunatCommandEnvelope,
    identity: FiscalDocumentIdentity,
    operation: SubmissionOperation,
  ): Promise<BeginSubmissionResult> {
    return this.dependencies.submissionJournal.begin({
      commandEventId: command.eventId,
      organizationId: command.organizationId,
      issuerId: command.issuerId,
      identity,
      operation,
      payloadSha256: command.payloadSha256,
    });
  }

  private async existingSubmissionOutput(
    command: Extract<
      SunatCommandEnvelope,
      {
        type: 'sunat.document.issue.requested.v1' | 'sunat.document.void.requested.v1';
      }
    >,
    snapshot: FiscalDocumentSnapshot,
    submission: BeginSubmissionResult,
    artifacts: readonly ArtifactReference[],
    context: SunatCommandExecutionContext,
  ): Promise<CompletedSunatCommand | null> {
    if (submission.acquired || submission.status === 'failed') {
      return null;
    }
    const providerTrackingId =
      submission.providerTrackingId ?? localSubmissionId(toFiscalDocumentIdentity(snapshot));
    if (submission.status === 'rejected') {
      const payload: RejectedDocumentResultPayload = {
        documentId: snapshot.documentId,
        submissionId: providerTrackingId,
        code: submission.responseCode ?? 'SUNAT_REJECTED',
        description:
          submission.responseDescription ?? 'SUNAT rechazó previamente el documento fiscal.',
        artifacts: [...artifacts],
      };
      return {
        result: await this.buildResultEnvelope(command, 'sunat.document.rejected.v1', payload),
      };
    }
    if (submission.status === 'voided') {
      return this.voidedOutput(command, snapshot.documentId, providerTrackingId);
    }
    if (
      submission.status === 'accepted' &&
      command.type === 'sunat.document.issue.requested.v1' &&
      submission.providerTrackingId
    ) {
      const payload: AcceptedDocumentResultPayload = {
        documentId: snapshot.documentId,
        submissionId: submission.providerTrackingId,
        acceptedAt: this.now().toISOString(),
        observationCodes: [],
        artifacts: [...artifacts],
      };
      return {
        result: await this.buildResultEnvelope(command, 'sunat.document.accepted.v1', payload),
      };
    }
    return this.reconcilingOutput(
      command,
      snapshot,
      providerTrackingId,
      submission.ticket ?? submission.providerTrackingId ?? undefined,
      context,
    );
  }

  private async recordSubmissionOutcome(
    submissionId: string,
    attemptNumber: number,
    endpoint: string,
    startedAt: Date,
    outcome: SunatSubmissionOutcome | Extract<SunatReconciliationOutcome, { status: 'voided' }>,
  ): Promise<void> {
    const status =
      outcome.status === 'accepted' || outcome.status === 'accepted_with_observations'
        ? 'accepted'
        : outcome.status === 'voided'
          ? 'voided'
          : outcome.status === 'pending'
            ? 'reconciling'
            : 'rejected';
    const trackingId = outcome.providerTrackingId ?? null;
    const ticket = outcome.status === 'pending' ? trackingId : null;
    await this.dependencies.submissionJournal.recordAttempt({
      submissionId,
      attemptNumber,
      endpoint,
      outcome:
        outcome.status === 'accepted_with_observations'
          ? 'accepted'
          : outcome.status === 'voided'
            ? 'accepted'
            : outcome.status,
      providerTrackingId: trackingId,
      ticket,
      startedAt,
      completedAt: this.now(),
    });
    await this.dependencies.submissionJournal.complete({
      submissionId,
      status,
      providerTrackingId: trackingId,
      ticket,
      ...('responseCode' in outcome
        ? {
            responseCode: outcome.responseCode,
            responseDescription: outcome.description,
          }
        : {}),
    });
  }

  private async recordReconciliationOutcome(
    submissionId: string,
    attemptNumber: number,
    startedAt: Date,
    outcome: SunatReconciliationOutcome,
    ticket: string | undefined,
  ): Promise<void> {
    if (outcome.status === 'not_found') {
      await this.dependencies.submissionJournal.recordAttempt({
        submissionId,
        attemptNumber,
        endpoint: 'sunat-provider:getStatus',
        outcome: 'pending',
        errorCode: 'SUNAT_RECONCILIATION_NOT_FOUND',
        providerTrackingId: outcome.providerTrackingId,
        ticket: ticket ?? null,
        startedAt,
        completedAt: this.now(),
      });
      await this.dependencies.submissionJournal.complete({
        submissionId,
        status: 'reconciling',
        providerTrackingId: outcome.providerTrackingId,
        ticket: ticket ?? null,
      });
      return;
    }
    await this.recordSubmissionOutcome(
      submissionId,
      attemptNumber,
      'sunat-provider:getStatus',
      startedAt,
      outcome,
    );
  }

  private async recordAmbiguousSubmission(
    submissionId: string,
    attemptNumber: number,
    endpoint: string,
    startedAt: Date,
    providerTrackingId: string | null,
  ): Promise<void> {
    await this.dependencies.submissionJournal.recordAttempt({
      submissionId,
      attemptNumber,
      endpoint,
      outcome: 'ambiguous',
      errorCode: 'SUNAT_SUBMISSION_AMBIGUOUS',
      providerTrackingId,
      ticket: providerTrackingId,
      startedAt,
      completedAt: this.now(),
    });
    await this.dependencies.submissionJournal.complete({
      submissionId,
      status: 'reconciling',
      providerTrackingId,
      ticket: providerTrackingId,
    });
  }

  private async recordSubmissionFailure(
    submissionId: string,
    attemptNumber: number,
    endpoint: string,
    startedAt: Date,
    error: unknown,
  ): Promise<void> {
    const safeError = toSafeSunatError(error);
    await this.dependencies.submissionJournal.recordAttempt({
      submissionId,
      attemptNumber,
      endpoint,
      outcome: 'failed',
      errorCode: safeError.code,
      startedAt,
      completedAt: this.now(),
    });
    await this.dependencies.submissionJournal.complete({
      submissionId,
      status: 'failed',
      responseCode: safeError.code,
      responseDescription: safeError.message,
    });
  }
}

function assertReservableCommand(command: SunatCommandEnvelope): void {
  const value: unknown = command;
  if (value === null || typeof value !== 'object') {
    throw invalidCommandError();
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  const payload = record.payload;
  const knownType =
    type === 'sunat.document.issue.requested.v1' ||
    type === 'sunat.document.void.requested.v1' ||
    type === 'sunat.document.reconcile.requested.v1' ||
    type === 'sunat.received.sync.requested.v1';
  const requiredStrings = [
    record.eventId,
    record.correlationId,
    record.organizationId,
    record.issuerId,
    record.payloadRef,
  ];
  if (
    !knownType ||
    requiredStrings.some((entry) => typeof entry !== 'string' || !entry.trim()) ||
    typeof record.eventId !== 'string' ||
    record.eventId.length > 120 ||
    payload === null ||
    typeof payload !== 'object'
  ) {
    throw invalidCommandError();
  }
  const resourceId = (payload as Record<string, unknown>)[
    type === 'sunat.received.sync.requested.v1' ? 'syncId' : 'documentId'
  ];
  if (typeof resourceId !== 'string' || !resourceId.trim()) {
    throw invalidCommandError();
  }
}

function invalidCommandError(): SunatValidationError {
  return new SunatValidationError(
    'SUNAT_INVALID_COMMAND',
    'El comando SUNAT tiene un formato inválido.',
  );
}

function assertSafeCommand(command: SunatCommandEnvelope): void {
  if (!/^[a-f0-9]{64}$/i.test(command.payloadSha256)) {
    throw new SunatValidationError(
      'SUNAT_INVALID_PAYLOAD_HASH',
      'El comando SUNAT no contiene una huella SHA-256 válida.',
    );
  }
  if (!command.eventId.trim() || !command.payloadRef.trim() || !command.issuerId.trim()) {
    throw new SunatValidationError(
      'SUNAT_INVALID_COMMAND',
      'El comando SUNAT no contiene sus identificadores obligatorios.',
    );
  }
  rejectSensitiveKeys(command);
}

function rejectSensitiveKeys(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectSensitiveKeys(child, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/password|clientsecret|access[_-]?token|private[_-]?key|certificatepem/i.test(key)) {
      throw new SunatValidationError(
        'SUNAT_SECRET_IN_COMMAND',
        `El comando contiene un campo sensible no permitido en ${path}.`,
      );
    }
    rejectSensitiveKeys(child, `${path}.${key}`);
  }
}

function assertIssueSummaryMatches(
  summary: {
    documentId: string;
    documentType: string;
    series: string;
    number: string;
  },
  snapshot: FiscalDocumentSnapshot,
): void {
  assertDocumentSummaryMatches(summary, snapshot);
}

function assertDocumentSummaryMatches(
  summary: {
    documentId: string;
    documentType: string;
    series: string;
    number: string;
  },
  snapshot: FiscalDocumentSnapshot,
): void {
  if (
    summary.documentId !== snapshot.documentId ||
    summary.documentType !== snapshot.documentType ||
    summary.series.toUpperCase() !== snapshot.series.toUpperCase() ||
    normalizeDocumentNumber(summary.number) !== normalizeDocumentNumber(snapshot.number)
  ) {
    throw new SunatValidationError(
      'SUNAT_COMMAND_SNAPSHOT_MISMATCH',
      'El resumen del comando no coincide con el snapshot fiscal inmutable.',
    );
  }
}

function normalizeDocumentNumber(value: string): string {
  return value.replace(/^0+(?=\d)/, '');
}

function assertSyncSummaryMatches(
  summary: {
    syncId: string;
    startDate: string;
    endDate: string;
    documentTypes: readonly string[];
  },
  request: ReturnType<typeof parseReceivedDocumentSyncRequest>,
): void {
  if (
    summary.syncId !== request.syncId ||
    summary.startDate !== request.dateFrom ||
    summary.endDate !== request.dateTo ||
    summary.documentTypes.join(',') !== request.documentTypes.join(',')
  ) {
    throw new SunatValidationError(
      'SUNAT_COMMAND_SNAPSHOT_MISMATCH',
      'El resumen de sincronización no coincide con el payload inmutable.',
    );
  }
}

function terminalError(error: SunatError): SunatError {
  if (!error.retryable) {
    return error;
  }
  return new SunatError({
    category: error.category,
    code: `${error.code}_RETRIES_EXHAUSTED`,
    message: `${error.message} Se agotaron los reintentos automáticos.`,
  });
}

function isFinalAttempt(context: SunatCommandExecutionContext): boolean {
  return context.attempt >= context.maxAttempts;
}

function reconciliationAttempt(attempt: number): number {
  return 10_000 + attempt;
}

function localSubmissionId(identity: FiscalDocumentIdentity): string {
  return `local-${createHash('sha256')
    .update(
      [identity.issuerRuc, identity.documentType, identity.series, identity.number].join('-'),
      'utf8',
    )
    .digest('hex')
    .slice(0, 24)}`;
}

function deterministicId(seed: string): string {
  const hash = createHash('sha256').update(seed, 'utf8').digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function safePathPart(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

function compactArtifacts(values: readonly (ArtifactReference | null)[]): ArtifactReference[] {
  return values.filter((value): value is ArtifactReference => value !== null);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCanonicalJsonKeys(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
