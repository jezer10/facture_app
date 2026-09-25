/** Locale-independent key order shared by every canonical JSON boundary. */
export function compareCanonicalJsonKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
