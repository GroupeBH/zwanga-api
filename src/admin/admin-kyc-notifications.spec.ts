import { AdminService } from './admin.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycProvider, KycStatus } from '../users/entities/kyc-document.entity';
import { AwsKycSession } from '../users/aws-kyc/aws-kyc-session.entity';
import { identityHash } from '../users/aws-kyc/aws-kyc.policy';

describe('manual KYC decisions', () => {
  const fixture = () => {
    const document = {
      id: 'kyc',
      userId: 'user',
      status: KycStatus.PENDING,
      reviewedBy: null,
      rejectionReason: 'Old note',
    } as unknown as KycDocument;
    const user = {
      id: 'user',
      isActive: true,
      role: UserRole.PASSENGER,
      status: UserStatus.PENDING_KYC,
    };
    const documents = {
      findOne: jest.fn(async () => document),
      save: jest.fn(async (value) => value),
    };
    const users = {
      findOne: jest.fn(async () => user),
      update: jest.fn(async () => undefined),
    };
    const manager = {
      getRepository: jest.fn((entity) => (entity === User ? users : documents)),
    };
    const repository = {
      findOne: jest.fn(async () => ({ role: UserRole.ADMIN })),
      manager: { transaction: jest.fn(async (work) => work(manager)) },
    };
    const service: AdminService = Object.assign(
      Object.create(AdminService.prototype),
      {
        userRepository: repository,
        kycDocumentRepository: documents,
        logger: { log: jest.fn(), warn: jest.fn() },
        evidence: { enqueue: jest.fn().mockResolvedValue(undefined) },
      },
    );
    return { service, document, documents, users, manager };
  };

  it('saves a fresh decision under the user/document locks (the subscriber owns notification creation)', async () => {
    const f = fixture();
    await f.service.verifyKyc('kyc', 'admin', true);
    expect(f.documents.findOne).toHaveBeenCalledWith({
      where: { id: 'kyc' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(f.documents.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: KycStatus.APPROVED,
        reviewedBy: 'admin',
        reviewedAt: expect.any(Date),
        rejectionReason: null,
      }),
    );
    expect(f.users.update).toHaveBeenCalledWith('user', {
      status: UserStatus.ACTIVE,
    });
    expect((f.service as any).evidence.enqueue).toHaveBeenCalledWith(f.manager,expect.objectContaining({id:'kyc',status:KycStatus.APPROVED}));
  });

  it('does not save or create a new decision on an identical retry', async () => {
    const f = fixture();
    await f.service.verifyKyc('kyc', 'admin', true);
    const firstReviewedAt = f.document.reviewedAt;
    await f.service.verifyKyc('kyc', 'admin', true);
    expect(f.documents.save).toHaveBeenCalledTimes(1);
    expect(f.document.reviewedAt).toBe(firstReviewedAt);
  });

  it('preserves the Didit decision date when an admin confirms the same approval', async () => {
    const f = fixture();
    const reviewedAt = new Date('2026-10-07T10:00:00Z');
    Object.assign(f.document, { status: KycStatus.APPROVED, reviewedAt });
    await f.service.verifyKyc('kyc', 'admin', true);
    expect(f.document.reviewedAt).toBe(reviewedAt);
    expect(f.document.reviewedBy).toBe('admin');
  });

  it('does not reactivate a suspended account when identity is approved', async () => {
    const f = fixture();
    f.users.findOne.mockResolvedValue({
      id: 'user',
      isActive: true,
      role: UserRole.PASSENGER,
      status: UserStatus.SUSPENDED,
    });
    await f.service.verifyKyc('kyc', 'admin', true);
    expect(f.users.update).not.toHaveBeenCalled();
  });

  it('blocks AWS approval until server checks and archived evidence are ready', async () => {
    const f = fixture(); f.document.provider = KycProvider.AWS;
    f.manager.getRepository.mockImplementation((entity) => entity === User ? f.users : entity === KycDocument ? f.documents : { findOne: jest.fn().mockResolvedValue({ state: 'liveness', checks: {} }) } as any);
    await expect(f.service.verifyKyc('kyc', 'admin', true, 'Reviewed document')).rejects.toThrow('contrôles AWS');
    expect(f.documents.save).not.toHaveBeenCalled();
  });

  it('requires an audited image consultation and review note, then reuses the approval notification path', async () => {
    const f = fixture(); f.document.provider = KycProvider.AWS;
    const account = { id: 'user', firstName: 'Test', lastName: 'Example', isActive: true, status: UserStatus.PENDING_KYC, role: UserRole.PASSENGER };
    f.users.findOne.mockResolvedValue(account);
    const sessions = { findOne: jest.fn().mockResolvedValue({ id: 'session', archiveId: 'archive', state: 'review', identityHash: identityHash('Test', 'Example'), checks: { liveness: 'passed', face: 'passed' } }), update: jest.fn() };
    f.manager.getRepository.mockImplementation((entity) => entity === User ? f.users : entity === AwsKycSession ? sessions as any : f.documents);
    const query = jest.fn().mockResolvedValue([]);
    Object.assign(f.manager, { query });
    await expect(f.service.verifyKyc('kyc', 'admin', true, 'Reviewed document')).rejects.toThrow('Consultez');
    query.mockResolvedValue([{ id: 'proof' }]);
    await expect(f.service.verifyKyc('kyc', 'admin', true)).rejects.toThrow('Consultez');
    await f.service.verifyKyc('kyc', 'admin', true, 'Pièce RDC valide, noms contrôlés');
    expect(f.documents.save).toHaveBeenCalledWith(expect.objectContaining({ status: KycStatus.APPROVED, reviewedBy: 'admin' }));
    expect(sessions.update).toHaveBeenCalledWith('session', { reviewNote: 'Pièce RDC valide, noms contrôlés' });
    expect(f.document.providerMetadata ?? {}).not.toHaveProperty('manualReviewNote');
  });
});
