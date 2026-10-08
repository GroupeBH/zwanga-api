import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  ARCHIVE_MAX_BYTES,
  EvidenceBundle,
  isArchiveObjectKey,
} from './kyc-evidence.policy';

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
  async read(key: string): Promise<EvidenceBundle> {
    const result = await this.client.send(
      new GetObjectCommand(this.location(key)),
      { abortSignal: AbortSignal.timeout(20_000) },
    );
    if (!result.Body) throw new Error('ARCHIVE_NOT_READABLE');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > ARCHIVE_MAX_BYTES) {
        (result.Body as { destroy?: () => void }).destroy?.();
        throw new Error('ARCHIVE_TOO_LARGE');
      }
      chunks.push(Buffer.from(chunk));
    }
    const bundle = JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
    ) as EvidenceBundle;
    if (
      bundle.version !== 1 ||
      !Array.isArray(bundle.files) ||
      bundle.files.length > 12 ||
      !bundle.details
    )
      throw new Error('ARCHIVE_NOT_READABLE');
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
      const versions: string[] = [];
      let KeyMarker: string | undefined;
      let VersionIdMarker: string | undefined;
      let complete = false;
      for (let page = 0; page < 10; page++) {
        const result = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: location.Bucket,
            Prefix: location.Key,
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
          if (entry.Key !== location.Key) continue;
          if (!entry.VersionId) throw new Error('MISSING_VERSION_ID');
          versions.push(entry.VersionId);
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
      for (const VersionId of new Set(versions)) {
        await this.client.send(
          new DeleteObjectCommand({ ...location, VersionId }),
          options(),
        );
      }
    } catch {
      // AccessDenied/Object Lock/timeout are not evidence of successful erasure.
      throw new Error('ARCHIVE_PURGE_FAILED');
    }
  }
}
