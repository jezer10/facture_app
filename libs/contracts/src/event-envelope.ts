export interface EventEnvelope<TType extends string, TPayload> {
  readonly eventId: string;
  readonly type: TType;
  readonly version: 1;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly organizationId: string;
  readonly issuerId: string;
  readonly payloadRef: string;
  readonly payloadSha256: string;
  readonly payload: Readonly<TPayload>;
}

export interface ArtifactReference {
  readonly kind: 'canonical-json' | 'xml' | 'signed-xml' | 'zip' | 'cdr' | 'pdf';
  readonly objectKey: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}
