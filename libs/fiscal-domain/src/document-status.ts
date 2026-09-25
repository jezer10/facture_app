export const PUBLIC_DOCUMENT_STATUSES = [
  'queued',
  'processing',
  'accepted',
  'accepted_with_observations',
  'rejected',
  'failed',
  'void_pending',
  'voided',
] as const;

export type PublicDocumentStatus = (typeof PUBLIC_DOCUMENT_STATUSES)[number];

const ALLOWED_TRANSITIONS: Readonly<
  Record<PublicDocumentStatus, ReadonlySet<PublicDocumentStatus>>
> = Object.freeze({
  queued: new Set<PublicDocumentStatus>(['processing', 'failed']),
  processing: new Set<PublicDocumentStatus>([
    'accepted',
    'accepted_with_observations',
    'rejected',
    'failed',
  ]),
  accepted: new Set<PublicDocumentStatus>(['void_pending']),
  accepted_with_observations: new Set<PublicDocumentStatus>(['void_pending']),
  rejected: new Set<PublicDocumentStatus>(),
  failed: new Set<PublicDocumentStatus>(['queued']),
  void_pending: new Set<PublicDocumentStatus>(['voided', 'accepted', 'accepted_with_observations']),
  voided: new Set<PublicDocumentStatus>(),
});

export class InvalidDocumentStatusTransitionError extends Error {
  constructor(
    public readonly from: PublicDocumentStatus,
    public readonly to: PublicDocumentStatus,
  ) {
    super(`Invalid fiscal document status transition: ${from} -> ${to}`);
    this.name = 'InvalidDocumentStatusTransitionError';
  }
}

export class IneligibleNoteReferenceError extends Error {
  constructor(public readonly status: PublicDocumentStatus) {
    super(`A document in status ${status} cannot be referenced by a note`);
    this.name = 'IneligibleNoteReferenceError';
  }
}

export function canTransitionDocumentStatus(
  from: PublicDocumentStatus,
  to: PublicDocumentStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function assertDocumentStatusTransition(
  from: PublicDocumentStatus,
  to: PublicDocumentStatus,
): void {
  if (!canTransitionDocumentStatus(from, to)) {
    throw new InvalidDocumentStatusTransitionError(from, to);
  }
}

export function isEligibleNoteReferenceStatus(
  status: PublicDocumentStatus,
): status is 'accepted' | 'accepted_with_observations' {
  return status === 'accepted' || status === 'accepted_with_observations';
}

export function assertEligibleNoteReferenceStatus(status: PublicDocumentStatus): void {
  if (!isEligibleNoteReferenceStatus(status)) {
    throw new IneligibleNoteReferenceError(status);
  }
}
