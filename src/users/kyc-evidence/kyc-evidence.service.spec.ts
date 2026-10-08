import { KycEvidenceService } from './kyc-evidence.service';
import { KycEvidenceController } from './kyc-evidence.controller';
import { ROLES_KEY } from '../../common/guards/roles.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserRole } from '../entities/user.entity';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import * as images from '../../common/image-upload-policy';

describe('KYC evidence worker and admin reads', () => {
  const settings = {
    days: 30,
    hosts: ['media.didit.test'],
    bucket: 'private-test',
    apiKey: 'synthetic',
  };
  let service: KycEvidenceService,
    repository: any,
    transport: any,
    storage: any,
    row: any;
  beforeEach(() => {
    repository = {
      claim: jest.fn(),
      claimPurge: jest.fn(),
      finish: jest.fn(),
      finishPurge: jest.fn(),
      readable: jest.fn(),
      audit: jest.fn(),
      expire: jest.fn(),
    };
    transport = {
      decision: jest.fn().mockResolvedValue({
        session_id: 's',
        vendor_data: 'u',
        id_verifications: [
          {
            front_image: 'https://media.didit.test/front',
            document_number: 'TEST',
          },
        ],
        liveness_checks: [
          { reference_image: 'https://media.didit.test/selfie' },
        ],
      }),
      image: jest.fn().mockResolvedValue(Buffer.from('original')),
    };
    storage = { write: jest.fn(), read: jest.fn(), remove: jest.fn() };
    row = {
      id: 'a',
      kycId: 'k',
      userId: 'u',
      sessionId: 's',
      attempts: 1,
      objectKeys: ['key'],
      expiresAt: new Date(Date.now() + 86400000),
      objectKey: 'key',
    };
    service = new KycEvidenceService(
      { get: () => undefined } as any,
      repository,
      transport,
      storage,
    );
    jest.spyOn(images, 'normalizeUploadedImage').mockResolvedValue({
      buffer: Buffer.from('normalized'),
      size: 10,
      mimetype: 'image/jpeg',
      originalname: 'image.jpg',
    });
  });
  afterEach(() => jest.restoreAllMocks());
  it('collects document and selfie with selected details, without persisting source URLs', async () => {
    await service.capture(row, settings);
    expect(storage.write).toHaveBeenCalledWith(
      'key',
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ kind: 'document_front' }),
          expect.objectContaining({ kind: 'selfie' }),
        ]),
      }),
    );
    expect(JSON.stringify(storage.write.mock.calls[0][1])).not.toContain(
      'https://',
    );
    expect(repository.finish).toHaveBeenCalledWith(row, 'ready', 'key', null);
  });
  it('retries a missing selfie then marks a final partial archive honestly', async () => {
    transport.decision.mockResolvedValue({
      session_id: 's',
      id_verifications: [{ front_image: 'url' }],
    });
    await service.capture(row, settings);
    expect(storage.write).not.toHaveBeenCalled();
    expect(repository.finish).toHaveBeenLastCalledWith(
      row,
      'pending',
      null,
      'EVIDENCE_INCOMPLETE',
    );
    row.attempts = 5;
    await service.capture(row, settings);
    expect(repository.finish).toHaveBeenLastCalledWith(
      row,
      'partial',
      'key',
      'EVIDENCE_INCOMPLETE',
    );
    expect(storage.write.mock.calls[0][1].missing).toContain('selfie');
  });
  it('captures an archive without an expiration date', async () => {
    row.expiresAt = null;
    await service.capture(row, { ...settings, days: 0 });
    expect(storage.write).toHaveBeenCalled();
    expect(repository.finish).toHaveBeenCalledWith(row, 'ready', 'key', null);
  });
  it('does not upload an archive whose explicit deadline has passed', async () => {
    row.expiresAt = new Date(Date.now() - 1000);
    await service.capture(row, settings);
    expect(storage.write).not.toHaveBeenCalled();
  });
  it('rejects another user session before any media download', async () => {
    transport.decision.mockResolvedValue({
      session_id: 's',
      vendor_data: 'someone-else',
    });
    await service.capture(row, settings);
    expect(transport.image).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    expect(repository.finish).toHaveBeenCalledWith(
      row,
      'failed',
      null,
      'SESSION_OWNER_MISMATCH',
    );
  });
  it('retains a retry on S3 failure without propagating it to KYC', async () => {
    storage.write.mockRejectedValue(new Error('storage secret'));
    await expect(service.capture(row, settings)).resolves.toBeUndefined();
    expect(repository.finish).toHaveBeenCalledWith(
      row,
      'pending',
      null,
      'CAPTURE_FAILED',
    );
  });
  it('keeps purging after collection has been disabled', async () => {
    repository.claimPurge
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(undefined);
    await service.tick();
    expect(storage.remove).toHaveBeenCalledWith('key');
    expect(repository.finishPurge).toHaveBeenCalledWith(row, true);
    expect(repository.claim).not.toHaveBeenCalled();
  });
  it('records unsuccessful purge for another attempt instead of losing object keys', async () => {
    repository.claimPurge.mockResolvedValueOnce(row);
    storage.remove.mockRejectedValue(new Error('denied'));
    await service.tick();
    expect(repository.finishPurge).toHaveBeenCalledWith(row, false);
  });
  it('denies expired/missing evidence without reading storage', async () => {
    await expect(service.details('k', 'a', 'admin')).rejects.toThrow(
      'Archive indisponible',
    );
    expect(storage.read).not.toHaveBeenCalled();
  });
  it('audits before returning data and keeps image bytes out of the details response', async () => {
    repository.readable.mockResolvedValue(row);
    storage.read.mockResolvedValue({
      sessionId: 's',
      details: { document: 'TEST' },
      files: [{ data: 'secret-base64', kind: 'selfie' }],
      missing: [],
    });
    const result = await service.details('k', 'a', 'admin');
    expect(repository.audit).toHaveBeenCalledWith('a', 'admin', 'read');
    expect(JSON.stringify(result)).not.toContain('secret-base64');
    expect(repository.audit.mock.invocationCallOrder[0]).toBeLessThan(
      storage.read.mock.invocationCallOrder[0],
    );
  });
  it('fails closed if auditing is unavailable or the dossier disappears during storage read', async () => {
    repository.readable
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(undefined);
    storage.read.mockResolvedValue({ sessionId: 's', files: [] });
    await expect(service.details('k', 'a', 'admin')).rejects.toThrow(
      'Archive temporairement',
    );
    repository.readable.mockResolvedValue(row);
    repository.audit.mockRejectedValue(new Error('audit failed'));
    storage.read.mockClear();
    await expect(service.details('k', 'a', 'admin')).rejects.toThrow();
    expect(storage.read).not.toHaveBeenCalled();
  });
  it('restricts every evidence route to authenticated admins', () => {
    expect(Reflect.getMetadata(ROLES_KEY, KycEvidenceController)).toEqual([
      UserRole.ADMIN,
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, KycEvidenceController),
    ).toContain(JwtAuthGuard);
  });
  it('bounds simultaneous bundle reads and releases capacity afterward', async () => {
    repository.readable.mockResolvedValue(row);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.read.mockImplementation(async () => {
      await pending;
      return { sessionId: 's', details: {}, files: [], missing: [] };
    });
    const first = service.details('k', 'a', 'admin'),
      second = service.details('k', 'a', 'admin');
    await expect(service.details('k', 'a', 'admin')).rejects.toThrow(
      'Lecture KYC occupée',
    );
    release();
    await Promise.all([first, second]);
    await expect(service.details('k', 'a', 'admin')).resolves.toMatchObject({
      files: [],
    });
  });
});
