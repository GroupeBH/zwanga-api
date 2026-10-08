import { ConfigService } from '@nestjs/config';

export const ARCHIVE_MAX_BYTES = 24 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export type EvidenceMedia = {
  kind: 'document_front' | 'document_back' | 'selfie';
  nodeId: string | null;
  url: string;
};
export type EvidenceFile = Omit<EvidenceMedia, 'url'> & {
  mimeType: 'image/jpeg';
  data: string;
  sha256: string;
  size: number;
};
export type EvidenceBundle = {
  version: 1;
  sessionId: string;
  capturedAt: string;
  details: Record<string, unknown>;
  files: EvidenceFile[];
  missing: string[];
};
export type ArchiveRow = {
  id: string;
  kycId: string | null;
  userId: string | null;
  sessionId: string;
  state: string;
  attempts: number;
  leaseToken: string;
  objectKeys: string[];
  objectKey: string | null;
  // null means no age-based expiration; explicit/account deletion still purges.
  expiresAt: Date | null;
  createdAt: Date;
  archivedAt: Date | null;
  errorCode: string | null;
};

export function archiveConfig(config: ConfigService) {
  const retention = String(
    config.get('DIDIT_KYC_ARCHIVE_RETENTION_DAYS') ?? '',
  ).trim();
  const days = Number(retention);
  const hosts = String(config.get('DIDIT_KYC_MEDIA_HOSTS') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bucket = config.get<string>('AWS_S3_BUCKET_NAME');
  const apiKey =
    config.get<string>('DIDIT_API_KEY') ||
    config.get<string>('DIDIT_KYC_API_KEY');
  if (
    config.get('DIDIT_KYC_ARCHIVE_ENABLED') !== 'true' ||
    !retention ||
    !Number.isInteger(days) ||
    days < 0 ||
    days > 3650 ||
    config.get('AWS_S3_PUBLIC_BUCKET') === 'true' ||
    !bucket ||
    !apiKey ||
    !hosts.length ||
    hosts.some(
      (h) => !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(h) || !h.includes('.'),
    )
  )
    return null;
  return { days, hosts, bucket, apiKey };
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown, max = 256) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const fields = (source: Record<string, unknown>, names: string[]) =>
  Object.fromEntries(names.map((n) => [n, str(source[n])]));
const reports = (source: Record<string, unknown>, key: string) => {
  const values = source[key];
  if (values != null && !Array.isArray(values))
    throw new Error('UNSUPPORTED_DECISION_SHAPE');
  if (Array.isArray(values) && values.length > 4)
    throw new Error('TOO_MANY_VERIFICATION_STEPS');
  return Array.isArray(values) ? values.map(object) : [];
};

// Explicit V3 feature arrays only. Never follow matches[]: those can identify OTHER people.
export function extractEvidence(
  payload: unknown,
  sessionId: string,
  userId: string,
) {
  const root = object(payload);
  const decision = root.decision ? { ...root, ...object(root.decision) } : root;
  if (
    decision.session_id !== sessionId ||
    (decision.vendor_data != null && decision.vendor_data !== userId) ||
    (decision.session_kind != null && decision.session_kind !== 'user')
  )
    throw new Error('SESSION_OWNER_MISMATCH');
  const ids = reports(decision, 'id_verifications');
  const liveness = reports(decision, 'liveness_checks');
  const faceMatches = reports(decision, 'face_matches');
  const media: EvidenceMedia[] = [];
  const add = (
    kind: EvidenceMedia['kind'],
    item: Record<string, unknown>,
    url: unknown,
  ) => {
    if (typeof url === 'string' && url.length && url.length <= 8192)
      media.push({ kind, nodeId: str(item.node_id), url });
  };
  for (const item of ids) {
    add('document_front', item, item.front_image);
    add('document_back', item, item.back_image);
  }
  for (const item of liveness) add('selfie', item, item.reference_image);
  // Only the current live target is a selfie; source_image may belong to another session.
  if (!media.some((m) => m.kind === 'selfie'))
    for (const item of faceMatches) add('selfie', item, item.target_image);
  return {
    media,
    details: {
      status: str(decision.status),
      workflowId: str(decision.workflow_id),
      providerCreatedAt: str(decision.created_at),
      documents: ids.map((item) =>
        fields(item, [
          'node_id',
          'status',
          'document_type',
          'document_number',
          'first_name',
          'last_name',
          'full_name',
          'date_of_birth',
          'date_of_issue',
          'expiration_date',
          'issuing_state',
          'nationality',
        ]),
      ),
      liveness: liveness.map((item) =>
        fields(item, ['node_id', 'status', 'method']),
      ),
      faceMatches: faceMatches.map((item) =>
        fields(item, ['node_id', 'status']),
      ),
    },
  };
}

export const archiveObjectKey = (id: string, token: string) =>
  `kyc/evidence/${id}/${token}.json`;
export const isArchiveObjectKey = (key: string) =>
  /^kyc\/evidence\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.json$/.test(key);
