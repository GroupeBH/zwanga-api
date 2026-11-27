import { createHash } from 'crypto';
import { ATTACHMENTS, AttachmentKind } from './didit-archive.policy';
import {
  ARCHIVE_MAX_BYTES,
  MEDIA_MAX_BYTES,
  EvidenceBundle,
  EvidenceFile,
  isArchiveObjectKey,
} from './kyc-evidence.policy';

export type EvidenceMetadata = Omit<EvidenceBundle, 'version' | 'files'> & {
  files: Omit<EvidenceFile, 'data'>[];
};
export type EvidenceManifest = Omit<EvidenceBundle, 'version' | 'files'> & {
  version: 2;
  files: (Omit<EvidenceFile, 'data'> & { objectKey: string })[];
};
export type StoredEvidence = EvidenceBundle | EvidenceManifest;

export function evidenceObjectPrefix(manifestKey: string): string {
  if (!isArchiveObjectKey(manifestKey)) throw new Error('INVALID_ARCHIVE_KEY');
  return manifestKey.slice(0, -'.json'.length);
}

export function evidenceImageKey(manifestKey: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 12)
    throw new Error('INVALID_IMAGE_INDEX');
  return `${evidenceObjectPrefix(manifestKey)}/${index}.jpg`;
}

export function evidenceAttachmentKey(
  key: string,
  kind: AttachmentKind,
): string {
  if (!Object.hasOwn(ATTACHMENTS, kind)) throw new Error('INVALID_ATTACHMENT');
  return `${evidenceObjectPrefix(key)}/${ATTACHMENTS[kind].filename}`;
}

// The lease is an ownership boundary: never read/delete another attempt's images.
export function ownsEvidenceObject(manifestKey: string, key: string): boolean {
  return (
    key === manifestKey ||
    (Object.keys(ATTACHMENTS) as AttachmentKind[]).some(
      (kind) => evidenceAttachmentKey(manifestKey, kind) === key,
    ) ||
    Array.from({ length: 12 }, (_, index) =>
      evidenceImageKey(manifestKey, index),
    ).includes(key)
  );
}

export function verifyEvidenceImage(
  body: Buffer,
  file: Omit<EvidenceFile, 'data'>,
  maxBytes = MEDIA_MAX_BYTES,
): void {
  if (
    body.length !== file.size ||
    body.length > maxBytes ||
    createHash('sha256').update(body).digest('hex') !== file.sha256
  )
    throw new Error('ARCHIVE_IMAGE_INTEGRITY_FAILED');
}

export function parseEvidence(value: unknown, key: string): StoredEvidence {
  evidenceObjectPrefix(key);
  const archive = value as StoredEvidence;
  if (
    !archive ||
    ![1, 2].includes(archive.version) ||
    typeof archive.sessionId !== 'string' ||
    !archive.sessionId ||
    typeof archive.capturedAt !== 'string' ||
    !archive.details ||
    typeof archive.details !== 'object' ||
    Array.isArray(archive.details) ||
    !Array.isArray(archive.files) ||
    archive.files.length > 12 ||
    !Array.isArray(archive.missing) ||
    !archive.missing.every((item) => typeof item === 'string')
  )
    throw new Error('ARCHIVE_NOT_READABLE');
  let encodedSize = 0;
  archive.files.forEach((file, index) => {
    if (
      !file ||
      !['document_front', 'document_back', 'selfie'].includes(file.kind) ||
      (file.nodeId !== null && typeof file.nodeId !== 'string') ||
      file.mimeType !== 'image/jpeg' ||
      !Number.isInteger(file.size) ||
      file.size <= 0 ||
      file.size >
        (archive.version === 1 ? ARCHIVE_MAX_BYTES : MEDIA_MAX_BYTES) ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('ARCHIVE_NOT_READABLE');
    encodedSize += 4 * Math.ceil(file.size / 3);
    if (archive.version === 2) {
      if (archive.files[index].objectKey !== evidenceImageKey(key, index))
        throw new Error('ARCHIVE_IMAGE_KEY_MISMATCH');
    } else if (
      typeof archive.files[index].data !== 'string' ||
      archive.files[index].data.length !== 4 * Math.ceil(file.size / 3)
    ) {
      throw new Error('ARCHIVE_NOT_READABLE');
    }
  });
  if (encodedSize > ARCHIVE_MAX_BYTES) throw new Error('ARCHIVE_TOO_LARGE');
  if (archive.attachments !== undefined) {
    if (!Array.isArray(archive.attachments) || archive.attachments.length > 3)
      throw new Error('ARCHIVE_NOT_READABLE');
    const kinds = new Set<string>();
    for (const item of archive.attachments) {
      if (
        !item ||
        !Object.hasOwn(ATTACHMENTS, item.kind) ||
        kinds.has(item.kind)
      )
        throw new Error('ARCHIVE_NOT_READABLE');
      const policy = ATTACHMENTS[item.kind];
      if (
        item.mimeType !== policy.mimeType ||
        !Number.isInteger(item.size) ||
        item.size <= 0 ||
        item.size > policy.maxBytes ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      )
        throw new Error('ARCHIVE_NOT_READABLE');
      kinds.add(item.kind);
    }
  }
  return archive;
}

export function evidenceMetadata(archive: StoredEvidence): EvidenceMetadata {
  return {
    sessionId: archive.sessionId,
    capturedAt: archive.capturedAt,
    details: archive.details,
    missing: archive.missing,
    ...(archive.attachments
      ? {
          attachments: archive.attachments.map(
            ({ kind, mimeType, size, sha256 }) => ({
              kind,
              mimeType,
              size,
              sha256,
            }),
          ),
        }
      : {}),
    files: archive.files.map((file) => ({
      kind: file.kind,
      nodeId: file.nodeId,
      mimeType: file.mimeType,
      sha256: file.sha256,
      size: file.size,
    })),
  };
}
