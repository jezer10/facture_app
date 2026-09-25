import type { SunatResultEnvelope } from '@app/contracts';
import { canonicalJson, sha256, type ObjectStoragePort } from '@app/platform';

const RESULT_KEY_PREFIX = 'sunat/results/';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Verifies the immutable result payload before Core trusts its inline copy. */
export async function verifyStoredSunatResult(
  storage: ObjectStoragePort,
  result: SunatResultEnvelope,
): Promise<void> {
  if (!isSafeResultKey(result.payloadRef)) {
    throw new Error('SUNAT result payloadRef is outside the private result namespace');
  }
  if (!SHA256_PATTERN.test(result.payloadSha256)) {
    throw new Error('SUNAT result payloadSha256 is invalid');
  }

  const body = await storage.get(result.payloadRef);
  if (sha256(body) !== result.payloadSha256) {
    throw new Error('SUNAT result payload hash mismatch');
  }

  let storedPayload: unknown;
  try {
    storedPayload = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error('SUNAT result payload is not valid JSON');
  }
  if (canonicalJson(storedPayload) !== canonicalJson(result.payload)) {
    throw new Error('SUNAT result inline payload differs from its immutable payload');
  }
}

function isSafeResultKey(key: string): boolean {
  return (
    key.startsWith(RESULT_KEY_PREFIX) &&
    !key.startsWith('/') &&
    !key.includes('..') &&
    !key.includes('\\')
  );
}
