import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import {
  ATTACHMENTS,
  AttachmentKind,
  EvidenceAttachment,
} from './didit-archive.policy';
import { checkedAttachment } from './evidence-attachment.stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  ARCHIVE_MAX_BYTES,
  MEDIA_MAX_BYTES,
  EvidenceBundle,
  isArchiveObjectKey,
} from './kyc-evidence.policy';
import {
  EvidenceManifest,
  StoredEvidence,
  evidenceImageKey,
  evidenceAttachmentKey,
  evidenceMetadata,
  evidenceObjectPrefix,
  ownsEvidenceObject,
  parseEvidence,
  verifyEvidenceImage,
} from './kyc-evidence.manifest';

@Injectable()
export class KycEvidenceStorage {
  private readonly client: S3Client;
  constructor(private readonly config: ConfigService) {
    this.client = new S3Client({
      region: config.get<string>('AWS_REGION') || 'us-east-1',
      maxAttempts: 2,
    });
  }
  private location(key: string) {
    const Bucket = this.config.get<string>('AWS_S3_BUCKET_NAME');
    if (!Bucket || !isArchiveObjectKey(key))
      throw new Error('ARCHIVE_STORAGE_NOT_CONFIGURED');
    return { Bucket, Key: key };
  }
  async write(key: string, bundle: EvidenceBundle) {
    const Body = Buffer.from(JSON.stringify(bundle));
    if (Body.length > ARCHIVE_MAX_BYTES) throw new Error('ARCHIVE_TOO_LARGE');
    await this.client.send(
      new PutObjectCommand({
        ...this.location(key),
        Body,
        IfNoneMatch: '*',
        ContentType: 'application/json',
        CacheControl: 'no-store',
        ServerSideEncryption: 'AES256',
      }),
      { abortSignal: AbortSignal.timeout(20_000) },
    );
  }

  // Legacy AWS KYC uploads keep write(); Didit now stores real private JPEGs.
  // The repository records the lease key BEFORE upload so interrupted writes
  // can be purged even when no manifest was successfully committed to S3.
  async writeImages(key: string, bundle: EvidenceBundle) {
    const location = this.location(key);
    if (this.config.get('AWS_S3_PUBLIC_BUCKET') === 'true')
      throw new Error('ARCHIVE_STORAGE_NOT_CONFIGURED');
    parseEvidence(bundle, key);
    for (const file of bundle.files)
      verifyEvidenceImage(Buffer.from(file.data, 'base64'), file);
    const metadata = evidenceMetadata(bundle);
    const manifest: EvidenceManifest = {
      version: 2,
      ...metadata,
      files: metadata.files.map((file, index) => ({
        ...file,
        objectKey: evidenceImageKey(key, index),
      })),
    };
    const body = Buffer.from(JSON.stringify(manifest));
    if (body.length > 128 * 1024) throw new Error('ARCHIVE_TOO_LARGE');
    const deadline = AbortSignal.timeout(120_000);
    const put = (Key: string, Body: Buffer, ContentType: string) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: location.Bucket,
          Key,
          Body,
          ContentType,
          IfNoneMatch: '*',
          CacheControl: 'no-store',
          ServerSideEncryption: 'AES256',
        }),
        {
          abortSignal: AbortSignal.any([deadline, AbortSignal.timeout(20_000)]),
        },
      );
    for (const [index, file] of bundle.files.entries())
      await put(
        evidenceImageKey(key, index),
        Buffer.from(file.data, 'base64'),
        'image/jpeg',
      );
    // Publishing the manifest last prevents readers from observing half an upload.
    await put(key, body, 'application/json');
  }

  private async get(
    location: { Bucket: string; Key: string },
    maxBytes: number,
    deadline: AbortSignal,
  ): Promise<Buffer> {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(20_000)]);
    const result = await this.client.send(new GetObjectCommand(location), {
      abortSignal: signal,
    });
    if (!result.Body) throw new Error('ARCHIVE_NOT_READABLE');
    const chunks: Buffer[] = [];
    let size = 0;
    const destroy = () => (result.Body as { destroy?: () => void }).destroy?.();
    signal.addEventListener('abort', destroy, { once: true });
    try {
      signal.throwIfAborted();
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) {
          destroy();
          throw new Error('ARCHIVE_TOO_LARGE');
        }
        chunks.push(Buffer.from(chunk));
      }
      signal.throwIfAborted();
      return Buffer.concat(chunks);
    } finally {
      signal.removeEventListener('abort', destroy);
    }
  }

  private async manifest(key: string, deadline: AbortSignal) {
    const body = await this.get(
      this.location(key),
      ARCHIVE_MAX_BYTES,
      deadline,
    );
    return parseEvidence(JSON.parse(body.toString('utf8')), key);
  }

  private async image(
    key: string,
    archive: StoredEvidence,
    index: number,
    deadline: AbortSignal,
  ) {
    const file = archive.files[index];
    if (!file) return null;
    const data =
      archive.version === 1
        ? Buffer.from(archive.files[index].data, 'base64')
        : await this.get(
            { ...this.location(key), Key: evidenceImageKey(key, index) },
            MEDIA_MAX_BYTES,
            deadline,
          );
    verifyEvidenceImage(
      data,
      file,
      archive.version === 1 ? ARCHIVE_MAX_BYTES : MEDIA_MAX_BYTES,
    );
    return data;
  }

  async readMetadata(key: string) {
    return evidenceMetadata(
      await this.manifest(key, AbortSignal.timeout(20_000)),
    );
  }

  async readFile(key: string, index: number) {
    // Validate before any S3 request, including for legacy bundles.
    evidenceImageKey(key, index);
    const deadline = AbortSignal.timeout(40_000);
    const archive = await this.manifest(key, deadline);
    return {
      sessionId: archive.sessionId,
      data: await this.image(key, archive, index, deadline),
    };
  }

  async writeAttachment(
    key: string,
    kind: AttachmentKind,
    source: Buffer | Readable,
    size: number,
  ): Promise<EvidenceAttachment> {
    const location = this.location(key);
    if (this.config.get('AWS_S3_PUBLIC_BUCKET') === 'true')
      throw new Error('ARCHIVE_STORAGE_NOT_CONFIGURED');
    const stream = Buffer.isBuffer(source) ? Readable.from([source]) : source;
    const checked = checkedAttachment(stream, kind, size);
    const signal = AbortSignal.timeout(90_000);
    const abort = () => checked.body.destroy(new Error('ATTACHMENT_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    // Avoid a raw stream error ever logging a provider URL via an SDK error.
    checked.body.on('error', () => undefined);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: location.Bucket,
          Key: evidenceAttachmentKey(key, kind),
          Body: checked.body,
          ContentLength: size,
          ContentType: ATTACHMENTS[kind].mimeType,
          IfNoneMatch: '*',
          CacheControl: 'no-store',
          ServerSideEncryption: 'AES256',
        }),
        { abortSignal: signal },
      );
      return {
        kind,
        mimeType: ATTACHMENTS[kind].mimeType,
        size,
        sha256: checked.digest(),
      };
    } finally {
      signal.removeEventListener('abort', abort);
      checked.body.destroy();
      stream.destroy();
    }
  }

  async readAttachment(key: string, kind: AttachmentKind) {
    const Key = evidenceAttachmentKey(key, kind);
    const deadline = AbortSignal.timeout(90_000);
    const archive = await this.manifest(key, deadline);
    const item = archive.attachments?.find((entry) => entry.kind === kind);
    if (!item) return { sessionId: archive.sessionId, attachment: null };
    const result = await this.client.send(
      new GetObjectCommand({ ...this.location(key), Key }),
      { abortSignal: deadline },
    );
    if (!(result.Body instanceof Readable))
      throw new Error('ARCHIVE_NOT_READABLE');
    const source = result.Body;
    source.on('error', () => undefined);
    if (result.ContentLength !== item.size) {
      source.destroy();
      throw new Error('ATTACHMENT_SIZE_MISMATCH');
    }
    const { body } = checkedAttachment(source, kind, item.size, item.sha256);
    const abort = () => body.destroy(new Error('ATTACHMENT_TIMEOUT'));
    body.on('error', () => undefined);
    deadline.addEventListener('abort', abort, { once: true });
    body.once('close', () => deadline.removeEventListener('abort', abort));
    if (deadline.aborted) abort();
    return { sessionId: archive.sessionId, attachment: { ...item, body } };
  }

  // Compatibility for AWS KYC processing, which still consumes a v1 bundle.
  async read(key: string): Promise<EvidenceBundle> {
    const deadline = AbortSignal.timeout(120_000);
    const archive = await this.manifest(key, deadline);
    const metadata = evidenceMetadata(archive);
    const bundle: EvidenceBundle = {
      ...metadata,
      version: 1,
      files: [],
    };
    for (const [index, file] of metadata.files.entries()) {
      const data = await this.image(key, archive, index, deadline);
      bundle.files.push({ ...file, data: data!.toString('base64') });
    }
    return bundle;
  }

  async remove(key: string) {
    const location = this.location(key);
    const deadline = AbortSignal.timeout(120_000);
    const options = () => ({
      abortSignal: AbortSignal.any([deadline, AbortSignal.timeout(20_000)]),
    });
    try {
      // Listing distinguishes never-uploaded keys from IAM failures and includes
      // versions hidden by delete markers. HEAD cannot establish either safely.
      const versions = new Map<string, { Key: string; VersionId: string }>();
      let KeyMarker: string | undefined;
      let VersionIdMarker: string | undefined;
      let complete = false;
      for (let page = 0; page < 10; page++) {
        const result = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: location.Bucket,
            Prefix: evidenceObjectPrefix(key),
            MaxKeys: 100,
            KeyMarker,
            VersionIdMarker,
          }),
          options(),
        );
        for (const entry of [
          ...(result.Versions ?? []),
          ...(result.DeleteMarkers ?? []),
        ]) {
          if (!entry.Key || !ownsEvidenceObject(key, entry.Key)) continue;
          if (!entry.VersionId) throw new Error('MISSING_VERSION_ID');
          versions.set(JSON.stringify([entry.Key, entry.VersionId]), {
            Key: entry.Key,
            VersionId: entry.VersionId,
          });
        }
        if (!result.IsTruncated) {
          complete = true;
          break;
        }
        if (
          !result.NextKeyMarker ||
          (result.NextKeyMarker === KeyMarker &&
            result.NextVersionIdMarker === VersionIdMarker)
        )
          throw new Error('INVALID_VERSION_PAGE');
        KeyMarker = result.NextKeyMarker;
        VersionIdMarker = result.NextVersionIdMarker;
      }
      if (!complete) throw new Error('VERSION_LIST_INCOMPLETE');
      // Enumerate before deleting so pagination never relies on a deleted marker.
      for (const version of versions.values()) {
        await this.client.send(
          new DeleteObjectCommand({ Bucket: location.Bucket, ...version }),
          options(),
        );
      }
    } catch {
      // AccessDenied/Object Lock/timeout are not evidence of successful erasure.
      throw new Error('ARCHIVE_PURGE_FAILED');
    }
  }
}
