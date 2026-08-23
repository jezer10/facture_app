import {
  assertDocumentStatusTransition,
  assertEligibleNoteReferenceStatus,
  canTransitionDocumentStatus,
  IneligibleNoteReferenceError,
  InvalidDocumentStatusTransitionError,
  isEligibleNoteReferenceStatus,
} from './document-status';

describe('fiscal document status transitions', () => {
  it.each([
    ['queued', 'processing'],
    ['queued', 'failed'],
    ['processing', 'accepted'],
    ['processing', 'accepted_with_observations'],
    ['processing', 'rejected'],
    ['processing', 'failed'],
    ['accepted', 'void_pending'],
    ['accepted_with_observations', 'void_pending'],
    ['failed', 'queued'],
    ['void_pending', 'voided'],
    ['void_pending', 'accepted'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransitionDocumentStatus(from, to)).toBe(true);
    expect(() => assertDocumentStatusTransition(from, to)).not.toThrow();
  });

  it.each([
    ['queued', 'accepted'],
    ['accepted', 'failed'],
    ['rejected', 'queued'],
    ['voided', 'queued'],
    ['processing', 'processing'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransitionDocumentStatus(from, to)).toBe(false);
    expect(() => assertDocumentStatusTransition(from, to)).toThrow(
      InvalidDocumentStatusTransitionError,
    );
  });
});

describe('note reference status eligibility', () => {
  it.each(['accepted', 'accepted_with_observations'] as const)(
    'accepts references in %s',
    (status) => {
      expect(isEligibleNoteReferenceStatus(status)).toBe(true);
      expect(() => assertEligibleNoteReferenceStatus(status)).not.toThrow();
    },
  );

  it.each(['queued', 'processing', 'rejected', 'failed', 'void_pending', 'voided'] as const)(
    'rejects references in %s',
    (status) => {
      expect(isEligibleNoteReferenceStatus(status)).toBe(false);
      expect(() => assertEligibleNoteReferenceStatus(status)).toThrow(IneligibleNoteReferenceError);
    },
  );
});
