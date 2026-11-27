import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import sharp = require('sharp');
import { archiveObjectKey, ArchiveRow } from './kyc-evidence.policy';
import { evidenceImageKey } from './kyc-evidence.manifest';
import { KycEvidenceService } from './kyc-evidence.service';
import { KycEvidenceStorage } from './kyc-evidence.storage';

describe('Didit evidence capture through private storage (synthetic, no cloud)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('normalizes document/selfie images, serves audited copies and purges all owned objects', async () => {
    const key = archiveObjectKey(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    const objects = new Map<string, Buffer>();
    jest.spyOn(S3Client.prototype, 'send').mockImplementation((async (
      command,
    ) => {
      if (command instanceof PutObjectCommand) {
        if (objects.has(command.input.Key!))
          throw new Error('PreconditionFailed');
        objects.set(
          command.input.Key!,
          Buffer.from(command.input.Body as Buffer),
        );
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const data = objects.get(command.input.Key!);
        if (!data) throw new Error('NoSuchKey');
        return { Body: Readable.from([data]) };
      }
      if (command instanceof ListObjectVersionsCommand)
        return {
          Versions: [...objects.keys()].map((Key) => ({
            Key,
            VersionId: 'null',
          })),
        };
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key!);
        return {};
      }
      throw new Error('Unexpected S3 command');
    }) as any);
    const row = {
      id: 'archive',
      kycId: 'kyc',
      userId: 'user',
      sessionId: 'session',
      attempts: 1,
      objectKeys: [key],
      objectKey: null,
      expiresAt: new Date(Date.now() + 1095 * 86400_000),
    } as unknown as ArchiveRow;
    const config = {
      get: (name: string) =>
        ({
          AWS_REGION: 'eu-central-1',
          AWS_S3_BUCKET_NAME: 'synthetic-private',
        })[name],
    };
    const repository = {
      finish: jest.fn(async (_row, state, objectKey) => {
        row.state = state;
        row.objectKey = objectKey;
      }),
      readable: jest.fn(async () => row),
      audit: jest.fn(),
      claimPurge: jest.fn(),
      finishPurge: jest.fn(),
    };
    // A real generated PNG, not a real person's face or identity document.
    const original = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#345678' },
    })
      .withMetadata()
      .png()
      .toBuffer();
    const transport = {
      decision: jest.fn(async () => ({
        session_id: 'session',
        vendor_data: 'user',
        status: 'Approved',
        id_verifications: [
          {
            front_image: 'https://media.didit.test/front',
            back_image: 'https://media.didit.test/back',
          },
        ],
        liveness_checks: [
          { reference_image: 'https://media.didit.test/selfie' },
        ],
      })),
      image: jest.fn(async () => original),
    };
    const storage = new KycEvidenceStorage(config as any);
    const service = new KycEvidenceService(
      config as any,
      repository as any,
      transport as any,
      storage,
    );
    await service.capture(row, {
      days: 1095,
      hosts: ['media.didit.test'],
      bucket: 'synthetic-private',
      apiKey: 'synthetic-key',
    });
    expect(row.state).toBe('ready');
    expect(objects.size).toBe(4);
    const details = await service.details('kyc', 'archive', 'admin');
    expect(details.files.map((file) => file.kind)).toEqual([
      'document_front',
      'document_back',
      'selfie',
    ]);
    expect(JSON.stringify(details)).not.toMatch(
      /objectKey|https:|kyc\/evidence/,
    );
    for (let index = 0; index < 3; index++) {
      const image = await service.file('kyc', 'archive', index, 'admin');
      expect(image).toEqual(objects.get(evidenceImageKey(key, index)));
      const metadata = await sharp(image).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
    }
    expect(repository.audit.mock.calls.map((call) => call[2])).toEqual([
      'read',
      'file',
      'file',
      'file',
    ]);
    row.expiresAt = new Date(Date.now() - 1);
    repository.claimPurge.mockResolvedValueOnce(row);
    // New collection is disabled, but expiration purge must still run.
    await service.tick();
    expect(repository.finishPurge).toHaveBeenCalledWith(row, true);
    expect(objects.size).toBe(0);
  });
});
