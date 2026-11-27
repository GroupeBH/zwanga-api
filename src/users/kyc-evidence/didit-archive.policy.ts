import { createHash } from 'crypto';

export const PROVIDER_DATA_MAX_BYTES = 8 * 1024 * 1024;
export const ORIGINAL_FILES_MAX_BYTES = 128 * 1024 * 1024;
export const REPORT_MAX_BYTES = 16 * 1024 * 1024;
export const ATTACHMENTS = {
  provider_data: {
    filename: 'provider.json',
    mimeType: 'application/json',
    maxBytes: PROVIDER_DATA_MAX_BYTES,
  },
  original_files: {
    filename: 'originals.zip',
    mimeType: 'application/zip',
    maxBytes: ORIGINAL_FILES_MAX_BYTES,
  },
  report: {
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    maxBytes: REPORT_MAX_BYTES,
  },
} as const;
export type AttachmentKind = keyof typeof ATTACHMENTS;
export type EvidenceAttachment = {
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  sha256: string;
};

export function diditObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function ownedDecision(
  payload: unknown,
  sessionId: string,
  userId: string,
) {
  const root = diditObject(payload);
  const value = root.decision
    ? { ...root, ...diditObject(root.decision) }
    : root;
  if (
    value.session_id !== sessionId ||
    (value.vendor_data != null && value.vendor_data !== userId) ||
    (value.session_kind != null && value.session_kind !== 'user')
  )
    throw new Error('SESSION_OWNER_MISMATCH');
  return value;
}

// Preserve every provider field, not just today's known features, except access
// credentials. URLs remain references, never live signed capabilities. Do not
// recurse into other users' APIs or follow arbitrary links found in this JSON.
export function archiveProviderData(value: unknown): unknown {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 200_000 || depth > 40)
      throw new Error('PROVIDER_DATA_TOO_COMPLEX');
    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item)) {
        try {
          const url = new URL(item);
          url.search = '';
          url.hash = '';
          url.username = '';
          url.password = '';
          return url.toString();
        } catch {
          return '[invalid URL]';
        }
      }
      return item;
    }
    if (Array.isArray(item))
      return item.map((child) => visit(child, depth + 1));
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          /^(?:.*(?:token|password|secret)|api[_-]?key|authorization|cookie)$/i.test(
            key,
          )
            ? '[redacted credential]'
            : visit(child, depth + 1),
        ]),
      );
    }
    return item;
  };
  return visit(value, 0);
}

export function providerFingerprint(payload: unknown): string {
  const stable = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(stable)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, stable(value)]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(stable(archiveProviderData(payload))))
    .digest('hex');
}

export function printableStatus(status: unknown): boolean {
  return (
    typeof status === 'string' &&
    ['approved', 'declined', 'inreview', 'kycexpired'].includes(
      status.toLowerCase().replace(/[ _-]/g, ''),
    )
  );
}
