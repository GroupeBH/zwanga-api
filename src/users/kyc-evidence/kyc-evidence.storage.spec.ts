import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { KycEvidenceStorage } from './kyc-evidence.storage';
import {
  archiveObjectKey,
  EvidenceBundle,
  MEDIA_MAX_BYTES,
} from './kyc-evidence.policy';
import {
  evidenceImageKey,
  evidenceAttachmentKey,
  evidenceMetadata,
  evidenceObjectPrefix,
} from './kyc-evidence.manifest';

describe('private KYC evidence storage', () => {
  const key = archiveObjectKey(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  );
  let storage: KycEvidenceStorage, send: jest.SpyInstance;
  beforeEach(() => {
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async () => ({}) as any);
    storage = new KycEvidenceStorage({
      get: (name: string) =>
        name === 'AWS_S3_BUCKET_NAME' ? 'private-test' : 'us-east-1',
    } as any);
  });
  afterEach(() => jest.restoreAllMocks());
  const bytes = Buffer.from('synthetic-normalized-image');
  const bundle = (): EvidenceBundle => ({
    version: 1,
    sessionId: 's',
    capturedAt: '2026-11-26T12:00:00Z',
    details: { documents: [] },
    missing: [],
    files: ['document_front', 'selfie'].map((kind) => ({
      kind: kind as 'document_front' | 'selfie',
      nodeId: null,
      mimeType: 'image/jpeg',
      data: bytes.toString('base64'),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  });
  const manifest = () => ({
    ...evidenceMetadata(bundle()),
    version: 2,
    files: evidenceMetadata(bundle()).files.map((file, index) => ({
      ...file,
      objectKey: evidenceImageKey(key, index),
    })),
  });
  const jsonBody = (value: unknown) => ({
    Body: Readable.from([Buffer.from(JSON.stringify(value))]),
  });
  it('streams private originals and publishes attachment metadata without a provider URL', async () => {
    const body = Buffer.from('PK\x03\x04synthetic original');
    const uploaded: Buffer[] = [];
    send.mockImplementation(async (command: any) => {
      for await (const chunk of command.input.Body)
        uploaded.push(Buffer.from(chunk));
      return {};
    });
    const attachment = await storage.writeAttachment(
      key,
      'original_files',
      Readable.from([body]),
      body.length,
    );
    expect(Buffer.concat(uploaded)).toEqual(body);
    expect(attachment).toEqual({
      kind: 'original_files',
      mimeType: 'application/zip',
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: evidenceAttachmentKey(key, 'original_files'),
      ContentLength: body.length,
      ServerSideEncryption: 'AES256',
      IfNoneMatch: '*',
      CacheControl: 'no-store',
    });
    send.mockResolvedValue({});
    await storage.writeImages(key, { ...bundle(), attachments: [attachment] });
    const saved = JSON.parse(send.mock.calls.at(-1)![0].input.Body.toString());
    expect(saved.attachments).toEqual([attachment]);
    send
      .mockResolvedValueOnce(jsonBody(saved))
      .mockResolvedValueOnce({
        Body: Readable.from([body]),
        ContentLength: body.length,
      });
    const result = await storage.readAttachment(key, 'original_files');
    const downloaded: Buffer[] = [];
    for await (const chunk of result.attachment!.body)
      downloaded.push(Buffer.from(chunk));
    expect(Buffer.concat(downloaded)).toEqual(body);
  });
  it('includes orphaned attachments and their versions in cleanup, not adjacent unrelated keys', async () => {
    const zip = evidenceAttachmentKey(key, 'original_files');
    const data = evidenceAttachmentKey(key, 'provider_data');
    send
      .mockResolvedValueOnce({
        Versions: [
          { Key: zip, VersionId: 'zip-v1' },
          { Key: data, VersionId: 'data-v1' },
          { Key: zip + '.unrelated', VersionId: 'keep' },
        ],
      })
      .mockResolvedValue({});
    await storage.remove(key);
    expect(
      send.mock.calls
        .filter((c) => c[0] instanceof DeleteObjectCommand)
        .map((c) => c[0].input.Key),
    ).toEqual([zip, data]);
  });
  it('writes an immutable encrypted private bundle without public ACL or cache', async () => {
    await storage.write(key, {
      version: 1,
      sessionId: 's',
      capturedAt: 'now',
      details: {},
      files: [],
      missing: [],
    } as EvidenceBundle);
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'private-test',
      Key: key,
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      CacheControl: 'no-store',
    });
    expect(send.mock.calls[0][0].input.ACL).toBeUndefined();
  });
  it('deletes the actual S3 version, not a delete marker', async () => {
    send
      .mockResolvedValueOnce({
        Versions: [{ Key: key, VersionId: 'version-1' }],
      })
      .mockResolvedValueOnce({});
    await storage.remove(key);
    expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'private-test',
      Prefix: evidenceObjectPrefix(key),
      MaxKeys: 100,
    });
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[1][0].input.VersionId).toBe('version-1');
  });
  it('does not mark an IAM denial as successful deletion', async () => {
    send
      .mockResolvedValueOnce({ Versions: [{ Key: key, VersionId: 'v' }] })
      .mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(storage.remove(key)).rejects.toThrow('ARCHIVE_PURGE_FAILED');
  });
  it('tolerates already absent objects but never swallows other failures', async () => {
    send.mockResolvedValueOnce({ Versions: [], DeleteMarkers: [] });
    await expect(storage.remove(key)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(storage.remove(key)).rejects.toThrow();
  });
  it('deletes hidden versions and markers, including the unversioned null version', async () => {
    send.mockResolvedValueOnce({
      Versions: [
        { Key: key, VersionId: 'hidden' },
        { Key: key, VersionId: 'null' },
        { Key: `${key}.unrelated`, VersionId: 'keep' },
      ],
      DeleteMarkers: [{ Key: key, VersionId: 'marker' }],
    });
    await storage.remove(key);
    expect(send.mock.calls.slice(1).map(([command]) => command.input)).toEqual(
      ['hidden', 'null', 'marker'].map((VersionId) => ({
        Bucket: 'private-test',
        Key: key,
        VersionId,
      })),
    );
  });
  it('enumerates every page before deleting versions', async () => {
    send
      .mockResolvedValueOnce({
        Versions: [{ Key: key, VersionId: 'first' }],
        IsTruncated: true,
        NextKeyMarker: key,
        NextVersionIdMarker: 'first',
      })
      .mockResolvedValueOnce({
        Versions: [{ Key: key, VersionId: 'second' }],
        IsTruncated: false,
      });
    await storage.remove(key);
    expect(send.mock.calls[1][0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect(send.mock.calls[1][0].input).toMatchObject({
      KeyMarker: key,
      VersionIdMarker: 'first',
    });
    expect(
      send.mock.calls.slice(2).map(([command]) => command.input.VersionId),
    ).toEqual(['first', 'second']);
  });
  it('fails closed on incomplete or invalid pagination', async () => {
    send.mockResolvedValueOnce({ IsTruncated: true });
    await expect(storage.remove(key)).rejects.toThrow('ARCHIVE_PURGE_FAILED');
    send.mockImplementation(async () => ({
      IsTruncated: true,
      NextKeyMarker: key,
      NextVersionIdMarker: 'same',
    }));
    await expect(storage.remove(key)).rejects.toThrow('ARCHIVE_PURGE_FAILED');
    expect(
      send.mock.calls.every(
        ([command]) => command instanceof ListObjectVersionsCommand,
      ),
    ).toBe(true);
  });
  it('refuses deletion when a matching object version cannot be identified', async () => {
    send.mockResolvedValueOnce({ Versions: [{ Key: key }] });
    await expect(storage.remove(key)).rejects.toThrow('ARCHIVE_PURGE_FAILED');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('never reads or removes a key outside the archive namespace', async () => {
    await expect(storage.read('profiles/file.jpg')).rejects.toThrow();
    await expect(storage.remove('kyc/evidence/../../secret')).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('writes JPEG objects before the immutable v2 manifest, without base64 in metadata', async () => {
    await storage.writeImages(key, bundle());
    const calls = send.mock.calls.map(([command]) => command.input);
    expect(calls.map((input) => [input.Key, input.ContentType])).toEqual([
      [evidenceImageKey(key, 0), 'image/jpeg'],
      [evidenceImageKey(key, 1), 'image/jpeg'],
      [key, 'application/json'],
    ]);
    for (const input of calls) {
      expect(input).toMatchObject({
        Bucket: 'private-test',
        IfNoneMatch: '*',
        CacheControl: 'no-store',
        ServerSideEncryption: 'AES256',
      });
      expect(input.ACL).toBeUndefined();
    }
    expect(calls[0].Body).toEqual(bytes);
    expect(JSON.parse(calls[2].Body.toString())).toEqual(manifest());
    expect(calls[2].Body.toString()).not.toContain(bytes.toString('base64'));
  });
  it('validates every image before the first upload', async () => {
    const invalid = bundle();
    invalid.files[1].sha256 = '0'.repeat(64);
    await expect(storage.writeImages(key, invalid)).rejects.toThrow(
      'INTEGRITY',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('never publishes a manifest after a failed image upload', async () => {
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('denied'));
    await expect(storage.writeImages(key, bundle())).rejects.toThrow();
    expect(send.mock.calls.map(([command]) => command.input.Key)).toEqual([
      evidenceImageKey(key, 0),
      evidenceImageKey(key, 1),
    ]);
  });
  it('refuses image upload to a bucket declared public', async () => {
    storage = new KycEvidenceStorage({
      get: (name: string) =>
        name === 'AWS_S3_PUBLIC_BUCKET' ? 'true' : 'private-test',
    } as any);
    await expect(storage.writeImages(key, bundle())).rejects.toThrow(
      'NOT_CONFIGURED',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it.each([1, 2])(
    'reads metadata v%s without image downloads or storage-key disclosure',
    async (version) => {
      send.mockResolvedValueOnce(
        jsonBody(version === 1 ? bundle() : manifest()),
      );
      expect(await storage.readMetadata(key)).toEqual(
        evidenceMetadata(bundle()),
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    },
  );
  it('downloads only the selected v2 image with integrity verification', async () => {
    send
      .mockResolvedValueOnce(jsonBody(manifest()))
      .mockResolvedValueOnce({ Body: Readable.from([bytes]) });
    expect(await storage.readFile(key, 1)).toEqual({
      sessionId: 's',
      data: bytes,
    });
    expect(send.mock.calls.map(([command]) => command.input.Key)).toEqual([
      key,
      evidenceImageKey(key, 1),
    ]);
  });
  it('continues reading images from legacy inline bundles', async () => {
    send.mockResolvedValueOnce(jsonBody(bundle()));
    expect(await storage.readFile(key, 0)).toEqual({
      sessionId: 's',
      data: bytes,
    });
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValueOnce(jsonBody(bundle()));
    expect(await storage.read(key)).toEqual(bundle());
  });
  it('hydrates v2 for internal legacy bundle consumers', async () => {
    send
      .mockResolvedValueOnce(jsonBody(manifest()))
      .mockResolvedValueOnce({ Body: Readable.from([bytes]) })
      .mockResolvedValueOnce({ Body: Readable.from([bytes]) });
    expect(await storage.read(key)).toEqual(bundle());
  });
  it('rejects an image reference outside this exact attempt before any image GET', async () => {
    const invalid = manifest();
    invalid.files[0].objectKey = 'kyc/evidence/another-person/0.jpg';
    send.mockResolvedValueOnce(jsonBody(invalid));
    await expect(storage.readFile(key, 0)).rejects.toThrow('KEY_MISMATCH');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects corrupt and oversized image bodies', async () => {
    send
      .mockResolvedValueOnce(jsonBody(manifest()))
      .mockResolvedValueOnce({ Body: Readable.from([Buffer.from('corrupt')]) });
    await expect(storage.readFile(key, 0)).rejects.toThrow('INTEGRITY');
    const body = Readable.from([Buffer.alloc(MEDIA_MAX_BYTES + 1)]);
    const destroy = jest.spyOn(body, 'destroy');
    send
      .mockResolvedValueOnce(jsonBody(manifest()))
      .mockResolvedValueOnce({ Body: body });
    await expect(storage.readFile(key, 0)).rejects.toThrow('TOO_LARGE');
    expect(destroy).toHaveBeenCalled();
  });
  it('rejects invalid indices without S3 access and missing images without another GET', async () => {
    await expect(storage.readFile(key, -1)).rejects.toThrow();
    await expect(storage.readFile(key, 12)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce(jsonBody(manifest()));
    expect(await storage.readFile(key, 2)).toEqual({
      sessionId: 's',
      data: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('purges orphaned images and all their versions without a manifest, never neighbouring attempts', async () => {
    const imageKey = evidenceImageKey(key, 0);
    send.mockResolvedValueOnce({
      Versions: [
        { Key: imageKey, VersionId: 'v1' },
        { Key: imageKey, VersionId: 'v2' },
        { Key: evidenceImageKey(key, 1), VersionId: 'v1' },
        { Key: `${evidenceObjectPrefix(key)}/12.jpg`, VersionId: 'keep' },
        { Key: `${evidenceObjectPrefix(key)}-other/0.jpg`, VersionId: 'keep' },
      ],
      DeleteMarkers: [{ Key: imageKey, VersionId: 'marker' }],
    });
    await storage.remove(key);
    expect(send.mock.calls.slice(1).map(([command]) => command.input)).toEqual([
      { Bucket: 'private-test', Key: imageKey, VersionId: 'v1' },
      { Bucket: 'private-test', Key: imageKey, VersionId: 'v2' },
      {
        Bucket: 'private-test',
        Key: evidenceImageKey(key, 1),
        VersionId: 'v1',
      },
      { Bucket: 'private-test', Key: imageKey, VersionId: 'marker' },
    ]);
  });
});
