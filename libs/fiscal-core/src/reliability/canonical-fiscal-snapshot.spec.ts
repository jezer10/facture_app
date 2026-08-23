import { createImmutableSnapshot } from '@app/fiscal-domain';
import { canonicalJson, sha256 } from '@app/platform';

import { canonicalFiscalSnapshotArtifact } from './canonical-fiscal-snapshot';

describe('canonicalFiscalSnapshotArtifact', () => {
  it('returns the exact canonical bytes shared with R2 and SUNAT', () => {
    const snapshot = { series: 'F001', number: '9007199254740993' };
    const expectedSha256 = sha256(canonicalJson(snapshot));

    expect(canonicalFiscalSnapshotArtifact(snapshot, expectedSha256)).toEqual({
      body: Buffer.from(canonicalJson(snapshot), 'utf8'),
      sha256: expectedSha256,
    });
  });

  it('fails when an immutable fiscal snapshot changed before a void command', () => {
    expect(() =>
      canonicalFiscalSnapshotArtifact(
        { series: 'F001', number: '43' },
        sha256(canonicalJson({ series: 'F001', number: '42' })),
      ),
    ).toThrow('snapshot hash');
  });

  it('rebuilds the exact artifact after a fiscal snapshot is persisted as JSON', () => {
    const created = createImmutableSnapshot({
      issuer: { address: { a: 'lower', A: 'upper' } },
    });
    const persisted = JSON.parse(created.canonicalJson) as Record<string, unknown>;

    expect(canonicalFiscalSnapshotArtifact(persisted, created.sha256)).toEqual({
      body: Buffer.from(created.canonicalJson, 'utf8'),
      sha256: created.sha256,
    });
  });
});
