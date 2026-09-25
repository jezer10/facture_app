import { createHash } from 'node:crypto';

import {
  SunatSubmissionAmbiguousError,
  SunatUnsafeConfigurationError,
} from '../../domain/errors/sunat.error';
import type {
  FiscalDocumentIdentity,
  ReceivedDocumentDescriptor,
  ReceivedDocumentSyncRequest,
} from '../../domain/models/fiscal-document';
import type {
  IssuerCredentialHandle,
  ReceivedDocumentSyncOutcome,
  SignedUblDocument,
  SunatProviderHealth,
  SunatReconciliationOutcome,
  SunatSubmissionOutcome,
  SunatVoidOutcome,
} from '../../domain/models/sunat-outcome';
import type { SunatProviderPort } from '../../domain/ports/sunat-provider.port';

export type MockSubmissionBehavior =
  | 'accept'
  | 'accept_with_observations'
  | 'reject'
  | 'pending'
  | 'ambiguous_after_accept';

export interface MockSunatProviderOptions {
  submissionBehavior?: MockSubmissionBehavior;
  receivedDocuments?: readonly ReceivedDocumentDescriptor[];
}

/** A deterministic provider that never performs network I/O. */
export class MockSunatProviderAdapter implements SunatProviderPort {
  private readonly outcomes = new Map<string, SunatSubmissionOutcome>();
  private readonly voidOutcomes = new Map<string, SunatVoidOutcome>();
  private readonly receivedDocuments: readonly ReceivedDocumentDescriptor[];
  private behavior: MockSubmissionBehavior;

  constructor(options: MockSunatProviderOptions = {}) {
    this.behavior = options.submissionBehavior ?? 'accept';
    this.receivedDocuments = options.receivedDocuments ?? [];
  }

  setSubmissionBehavior(behavior: MockSubmissionBehavior): void {
    this.behavior = behavior;
  }

  submitDocument(
    document: SignedUblDocument,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatSubmissionOutcome> {
    assertMockContext(credentials, document);
    const key = identityKey(document.identity);
    const existing = this.outcomes.get(key);
    if (existing) {
      return Promise.resolve(existing);
    }

    const trackingId = mockTrackingId(document);
    const outcome = createOutcome(this.behavior, trackingId);
    this.outcomes.set(key, outcome);

    if (this.behavior === 'ambiguous_after_accept') {
      return Promise.reject(new SunatSubmissionAmbiguousError(trackingId));
    }
    return Promise.resolve(outcome);
  }

  reconcileDocument(
    identity: FiscalDocumentIdentity,
    _providerTrackingId: string | null,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatReconciliationOutcome> {
    assertMockCredentials(credentials);
    return Promise.resolve(
      this.voidOutcomes.get(identityKey(identity)) ??
        this.outcomes.get(identityKey(identity)) ?? {
          status: 'not_found',
          providerTrackingId: null,
        },
    );
  }

  submitVoidCommunication(
    identity: FiscalDocumentIdentity,
    _reason: string,
    credentials: IssuerCredentialHandle,
  ): Promise<SunatVoidOutcome> {
    assertMockCredentials(credentials);
    const key = identityKey(identity);
    const existing = this.voidOutcomes.get(key);
    if (existing) {
      return Promise.resolve(existing);
    }
    const outcome: SunatVoidOutcome = {
      status: 'voided',
      providerTrackingId: `mock-void-${createHash('sha256')
        .update(key, 'utf8')
        .digest('hex')
        .slice(0, 20)}`,
      artifacts: [],
    };
    this.voidOutcomes.set(key, outcome);
    return Promise.resolve(outcome);
  }

  listReceivedDocuments(
    request: ReceivedDocumentSyncRequest,
    credentials: IssuerCredentialHandle,
  ): Promise<ReceivedDocumentSyncOutcome> {
    assertMockCredentials(credentials);
    const requestedTypes = new Set(request.documentTypes);
    const source = request.source ?? '2';
    const documents = this.receivedDocuments.filter(
      (document) =>
        requestedTypes.has(document.documentType) &&
        document.source === source &&
        document.issueDate >= request.dateFrom &&
        document.issueDate <= request.dateTo,
    );
    return Promise.resolve({
      documents: deduplicateDocuments(documents),
      sourceCursor: null,
    });
  }

  health(): Promise<SunatProviderHealth> {
    return Promise.resolve({
      ready: true,
      provider: 'mock',
      environment: 'mock',
      detail: 'Sin red ni validez fiscal; no usar para emisión real.',
    });
  }
}

function createOutcome(
  behavior: MockSubmissionBehavior,
  trackingId: string,
): SunatSubmissionOutcome {
  switch (behavior) {
    case 'reject':
      return {
        status: 'rejected',
        providerTrackingId: trackingId,
        responseCode: 'MOCK-REJECTED',
        description: 'Rechazo determinista del proveedor mock.',
        observations: [],
        cdrReference: null,
      };
    case 'pending':
      return { status: 'pending', providerTrackingId: trackingId };
    case 'accept_with_observations':
      return {
        status: 'accepted_with_observations',
        providerTrackingId: trackingId,
        responseCode: 'MOCK-0000',
        description: 'Aceptación simulada con observaciones.',
        observations: ['MOCK_ONLY'],
        cdrReference: null,
      };
    case 'accept':
    case 'ambiguous_after_accept':
      return {
        status: 'accepted',
        providerTrackingId: trackingId,
        responseCode: 'MOCK-0000',
        description: 'Aceptación simulada.',
        observations: ['MOCK_ONLY'],
        cdrReference: null,
      };
  }
}

function assertMockContext(credentials: IssuerCredentialHandle, document: SignedUblDocument): void {
  assertMockCredentials(credentials);
  if (document.signature.state !== 'mock_unsigned') {
    throw new SunatUnsafeConfigurationError(
      'El proveedor mock sólo acepta el artefacto explícitamente marcado como no firmado.',
    );
  }
}

function assertMockCredentials(credentials: IssuerCredentialHandle): void {
  if (credentials.environment !== 'mock') {
    throw new SunatUnsafeConfigurationError(
      'El proveedor mock no puede recibir credenciales beta o producción.',
    );
  }
}

function identityKey(identity: FiscalDocumentIdentity): string {
  return [identity.issuerRuc, identity.documentType, identity.series, identity.number].join('-');
}

function mockTrackingId(document: SignedUblDocument): string {
  return `mock-${createHash('sha256')
    .update(`${identityKey(document.identity)}:${document.sha256}`, 'utf8')
    .digest('hex')
    .slice(0, 24)}`;
}

function deduplicateDocuments(
  documents: readonly ReceivedDocumentDescriptor[],
): ReceivedDocumentDescriptor[] {
  const bySourceId = new Map<string, ReceivedDocumentDescriptor>();
  documents.forEach((document) => bySourceId.set(document.sourceId, document));
  return [...bySourceId.values()];
}
