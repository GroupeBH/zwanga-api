import { createHash, timingSafeEqual } from 'crypto';

// Tokens have high entropy; unlike a short PIN, their fingerprints need no slow KDF.
export function tokenFingerprint(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

export function matchesStoredToken(stored: string | null | undefined, token: string): boolean {
  if (!stored || !token) return false;
  // Existing sessions are migrated on their next successful refresh, without a logout.
  const expected = stored.startsWith('sha256:') ? stored : tokenFingerprint(stored);
  const actual = tokenFingerprint(token);
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
