import { canonicalJson, sha256 } from '@app/platform';

export interface CanonicalFiscalSnapshotArtifact {
  readonly body: Buffer;
  readonly sha256: string;
}

export function canonicalFiscalSnapshotArtifact(
  snapshot: Record<string, unknown>,
  expectedSha256: string,
): CanonicalFiscalSnapshotArtifact {
  const body = Buffer.from(canonicalJson(snapshot), 'utf8');
  const digest = sha256(body);
  if (digest !== expectedSha256) {
    throw new Error('Stored fiscal snapshot hash does not match its canonical payload');
  }
  return { body, sha256: digest };
}
