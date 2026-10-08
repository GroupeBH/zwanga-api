import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { KycEvidenceStorage } from './kyc-evidence.storage';
import { archiveObjectKey, EvidenceBundle } from './kyc-evidence.policy';

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
      Prefix: key,
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
});
