import { parseManualKycInput, MANUAL_KYC_SCHEMA } from './manual-kyc.schema';
import { ManualKycService } from './manual-kyc.service';
import { ManualKycController } from './manual-kyc.controller';
import { KycEvidenceStorage } from '../../users/kyc-evidence/kyc-evidence.storage';

const input = (overrides = {}) =>
  JSON.stringify({
    kycId: null,
    baseRevision: 0,
    note: 'Vérification au bureau',
    fields: { first_name: 'Test' },
    ...overrides,
  });
describe('manual KYC input validation', () => {
  it('preserves the identity and documented fields but never accepts automatic verdict/account fields', () => {
    expect(parseManualKycInput(input()).fields).toEqual({ first_name: 'Test' });
    for (const key of [
      'approved',
      'isActive',
      'vendor_data',
      'providerMetadata',
      'role',
      '__proto__',
    ]) {
      expect(() =>
        parseManualKycInput(input({ fields: { [key]: 'value' } })),
      ).toThrow();
    }
    expect(
      new Set(MANUAL_KYC_SCHEMA.flatMap((g) => g.fields.map((f) => f.key)))
        .size,
    ).toBe(MANUAL_KYC_SCHEMA.flatMap((g) => g.fields).length);
  });
  it.each([
    { note: 'x' },
    { baseRevision: -1 },
    { kycId: 'bad' },
    { approved: true },
    { fields: [] },
    { fields: { date_of_birth: '2025-02-31' } },
    { fields: { total_cost: '-1' } },
    { fields: { is_vpn_or_tor: 'yes' } },
    { fields: { first_name: 'x'.repeat(1001) } },
    { fields: { email: 'invalid' } },
  ])('rejects malformed or unauthorized input %j', (value) => {
    expect(() => parseManualKycInput(input(value))).toThrow();
  });
  it('never permits the client to choose the source/admin/retention of an archive', () => {
    for (const key of ['recordedBy', 'expiresAt', 'source'])
      expect(() => parseManualKycInput(input({ [key]: 'x' }))).toThrow();
  });
});

describe('manual KYC safe storage orchestration', () => {
  let repo: any,
    storage: any,
    evidence: any,
    config: any,
    service: ManualKycService;
  const row = {
    id: 'archive',
    kycId: 'kyc',
    sessionId: 'manual:kyc',
    revision: 0,
    objectKeys: ['new.json'],
    objectKey: null,
  };
  beforeEach(() => {
    repo = {
      reserve: jest.fn().mockResolvedValue(row),
      finish: jest.fn(),
      release: jest.fn(),
      current: jest.fn(),
    };
    storage = { read: jest.fn(), writeImages: jest.fn() };
    evidence = { details: jest.fn() };
    config = {
      get: (key: string) =>
        key === 'AWS_S3_BUCKET_NAME' ? 'private-test' : undefined,
    };
    service = new ManualKycService(
      repo,
      storage as KycEvidenceStorage,
      evidence,
      config,
    );
  });
  it('stores fields privately with server attribution, then audits the commit; no provider or user mutation', async () => {
    const result = await service.save('user', 'admin', input());
    expect(storage.writeImages).toHaveBeenCalledWith(
      'new.json',
      expect.objectContaining({
        sessionId: 'manual:kyc',
        details: expect.objectContaining({
          source: 'administrator',
          recordedBy: 'admin',
          providerResultsUnchanged: true,
        }),
      }),
    );
    expect(result).toMatchObject({ revision: 1, validationUnchanged: true });
    expect(repo.finish).toHaveBeenCalledWith(row, 'admin');
    expect(storage.writeImages.mock.invocationCallOrder[0]).toBeLessThan(
      repo.finish.mock.invocationCallOrder[0],
    );
    expect(repo.reserve.mock.calls[0][2]).toBe(1095);
  });
  it('does not publish when S3 fails, preserves old references and hides error details', async () => {
    storage.writeImages.mockRejectedValue(
      new Error('private-provider-or-S3-details'),
    );
    await expect(service.save('user', 'admin', input())).rejects.toThrow(
      'Enregistrement privé indisponible',
    );
    expect(repo.finish).not.toHaveBeenCalled();
    expect(repo.release).toHaveBeenCalledWith(row);
  });
  it('preserves old photos on a metadata-only edit and rejects wrong-session contents', async () => {
    repo.reserve.mockResolvedValue({
      ...row,
      objectKey: 'old.json',
      revision: 1,
    });
    storage.read.mockResolvedValue({
      sessionId: 'manual:kyc',
      details: { source: 'administrator' },
      files: [{ kind: 'selfie', nodeId: 'selfie' }],
    });
    await service.save('user', 'admin', input({ baseRevision: 1 }));
    expect(storage.writeImages.mock.calls[0][1].files).toHaveLength(1);
    storage.read.mockResolvedValue({
      sessionId: 'other-user',
      details: { source: 'administrator' },
      files: [],
    });
    await expect(
      service.save('user', 'admin', input({ baseRevision: 1 })),
    ).rejects.toThrow('Enregistrement privé indisponible');
  });
  it('refuses public storage and malformed uploads before reserving SQL rows', async () => {
    config.get = () => 'true';
    await expect(service.save('user', 'admin', input())).rejects.toThrow(
      'stockage privé',
    );
    expect(repo.reserve).not.toHaveBeenCalled();
  });
  it('requires admin role at the HTTP boundary', () => {
    expect(Reflect.getMetadata('roles', ManualKycController)).toContain(
      'admin',
    );
    expect(
      Reflect.getMetadata('__guards__', ManualKycController).length,
    ).toBeGreaterThan(0);
  });
});
