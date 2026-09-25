import { NotFoundException } from '@nestjs/common';
import { KycStatus } from '../users/entities/kyc-document.entity';
import { ProServiceConfiguration } from './pro-service.configuration';
import { ProServiceFinance } from './pro-service.finance';
import {
  ProServiceCase,
  ProServiceLedger,
  ProServiceOffering,
} from './pro-service.entities';
import { ProServiceStore } from './pro-service.store';
import { ProServiceWorkflow } from './pro-service.workflow';

const terms = {
  version: 'test-v1',
  text: 'Test contract text without legal significance.'.repeat(2),
  validationReference: 'test-proof',
  custodyCodes: ['carte-rose'],
  validatedBy: 'admin',
  validatedAt: '2026-01-01',
};
function fixture() {
  const item = {
    id: 'case',
    ownerId: 'owner',
    serviceCode: 'documents',
    status: 'quoted',
    acceptedAt: null,
    acceptedQuoteVersion: null,
    quote: {
      version: 1,
      currency: 'CDF',
      totalMinor: 1000000,
      depositMinor: 200000,
      providerName: 'Test provider',
      description: 'Test services only',
      validUntil: '2040-01-01',
      installments: [{ dueDate: '2040-02-01', amountMinor: 800000 }],
      retainedDocuments: [],
      terms,
    },
  } as unknown as ProServiceCase;
  const offering = { code: 'documents', availability: 'open', terms };
  const query = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getExists: jest.fn().mockResolvedValue(false),
  };
  const manager = {
    findOne: jest
      .fn()
      .mockImplementation((entity) =>
        entity === ProServiceOffering
          ? offering
          : { status: KycStatus.APPROVED },
      ),
    findOneBy: jest.fn().mockResolvedValue(null),
    findOneByOrFail: jest.fn().mockResolvedValue(offering),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((_entity, value) => value),
    save: jest.fn((...args) => Promise.resolve(args.at(-1))),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    getRepository: jest.fn(() => ({ createQueryBuilder: () => query })),
  };
  const store = {
    db: { transaction: jest.fn((callback) => callback(manager)) },
    requireCase: jest.fn().mockResolvedValue(item),
    activeUser: jest
      .fn()
      .mockResolvedValue({ id: 'owner', isPhoneVerified: true }),
    audit: jest.fn().mockResolvedValue({}),
  };
  const workflow = new ProServiceWorkflow(store as unknown as ProServiceStore);
  return {
    item,
    offering,
    manager,
    store,
    query,
    workflow,
    finance: new ProServiceFinance(
      store as unknown as ProServiceStore,
      workflow,
    ),
  };
}
describe('Pro services workflow and legal lock', () => {
  it('blocks acceptance when no validated contract exists', async () => {
    const f = fixture();
    f.offering.terms = null as any;
    await expect(
      f.workflow.accept('case', 'owner', { quoteVersion: 1, consent: true }),
    ).rejects.toThrow('conditions validées');
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('blocks an expired/replaced quote and unverified identity', async () => {
    const f = fixture();
    f.item.quote!.validUntil = '2000-01-01';
    await expect(
      f.workflow.accept('case', 'owner', { quoteVersion: 1, consent: true }),
    ).rejects.toThrow('expiré');
    f.item.quote!.validUntil = '2040-01-01';
    await expect(
      f.workflow.accept('case', 'owner', { quoteVersion: 2, consent: true }),
    ).rejects.toThrow('changé');
    f.manager.findOne.mockImplementation((entity) =>
      entity === ProServiceOffering
        ? f.offering
        : ({ status: KycStatus.REJECTED } as any),
    );
    await expect(
      f.workflow.accept('case', 'owner', { quoteVersion: 1, consent: true }),
    ).rejects.toThrow('identité');
  });
  it('accepts only for the owner under lock and is idempotent', async () => {
    const f = fixture();
    await f.workflow.accept('case', 'owner', {
      quoteVersion: 1,
      consent: true,
    });
    expect(f.store.activeUser).toHaveBeenCalledWith(f.manager, 'owner', true);
    expect(f.store.requireCase).toHaveBeenCalledWith(
      f.manager,
      'case',
      'owner',
      true,
    );
    expect(f.item.status).toBe('accepted');
    const saves = f.manager.save.mock.calls.length;
    await f.workflow.accept('case', 'owner', {
      quoteVersion: 1,
      consent: true,
    });
    expect(f.manager.save).toHaveBeenCalledTimes(saves);
    expect(
      f.manager.save.mock.calls.some((args) => args[0] === ProServiceLedger),
    ).toBe(false);
  });
  it('rejects overlapping engagements', async () => {
    const f = fixture();
    f.query.getExists.mockResolvedValue(true);
    await expect(
      f.workflow.accept('case', 'owner', { quoteVersion: 1, consent: true }),
    ).rejects.toThrow('encore en cours');
  });
  it('cannot engage a future service by modifying the client', async () => {
    const f = fixture();
    f.item.serviceCode = 'vehicles';
    await expect(
      f.workflow.accept('case', 'owner', { quoteVersion: 1, consent: true }),
    ).rejects.toThrow('bloqué');
  });
  it('retains accepted terms when newer terms are published, but honours suspension', async () => {
    const f = fixture();
    f.item.acceptedAt = new Date();
    f.offering.terms = { ...terms, version: 'test-v2' };
    await expect(
      f.workflow.legalGate(f.manager as any, f.item),
    ).resolves.toBeUndefined();
    f.offering.availability = 'paused';
    await expect(
      f.workflow.legalGate(f.manager as any, f.item),
    ).rejects.toThrow('bloqué');
  });
  it('never starts processing without the actual advance and deposit', async () => {
    const f = fixture();
    f.item.acceptedAt = new Date();
    f.item.acceptedQuoteVersion = 1;
    f.item.status = 'accepted';
    await expect(
      f.workflow.status('case', 'admin', { status: 'processing', message: '' }),
    ).rejects.toThrow('justificatifs');
  });
  it('replays the same financial reference but rejects a changed amount', async () => {
    const f = fixture();
    const dto = {
      kind: 'funding' as const,
      amountMinor: 800000,
      reference: 'test-ref',
      evidence: 'Verified receipt for test',
    };
    f.manager.findOneBy.mockResolvedValue({
      id: 'entry',
      caseId: 'case',
      kind: 'funding',
      amountMinor: 800000,
    });
    await expect(f.finance.record('case', 'admin', dto)).resolves.toEqual({
      id: 'entry',
    });
    await expect(
      f.finance.record('case', 'admin', { ...dto, amountMinor: 900000 }),
    ).rejects.toThrow('autre opération');
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('allows repayment while paused, releases originals but never marks them returned', async () => {
    const f = fixture();
    f.item.acceptedAt = new Date();
    f.item.acceptedQuoteVersion = 1;
    f.offering.availability = 'paused';
    f.manager.find.mockResolvedValue([
      { kind: 'funding', amountMinor: 800000 },
    ]);
    await f.finance.record('case', 'admin', {
      kind: 'repayment',
      amountMinor: 800000,
      reference: 'test-repaid',
      evidence: 'Verified repayment receipt',
    });
    expect(f.manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { caseId: 'case', status: 'held' },
      { status: 'release_ready' },
    );
  });
  it('refuses held originals without a contract and before funding', async () => {
    const f = fixture();
    f.item.acceptedAt = new Date();
    f.item.acceptedQuoteVersion = 1;
    f.manager.findOneBy.mockResolvedValue({
      id: 'doc',
      code: 'carte-rose',
      status: 'expected',
    });
    await expect(
      f.finance.custody('case', 'doc', 'admin', {
        action: 'receive',
        receipt: 'test-receipt',
        storageLocation: 'test-vault',
      }),
    ).rejects.toThrow('Aucune avance');
    f.offering.terms = null as any;
    await expect(
      f.finance.custody('case', 'doc', 'admin', {
        action: 'receive',
        receipt: 'test-receipt',
        storageLocation: 'test-vault',
      }),
    ).rejects.toThrow('bloqué');
  });
  it('enforces owner scoping in database reads', async () => {
    const manager = { findOne: jest.fn().mockResolvedValue(null) };
    const store = new ProServiceStore({} as any);
    await expect(
      store.requireCase(manager as any, 'case', 'other-owner'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.findOne).toHaveBeenCalledWith(ProServiceCase, {
      where: { id: 'case', ownerId: 'other-owner' },
    });
  });
  it('will not enable a legal gate with an empty contract or edit an old version', async () => {
    const f = fixture();
    const config = new ProServiceConfiguration(f.store as any);
    const dto = {
      availability: 'open' as const,
      legalValidated: true,
      termsVersion: 'test-v2',
      termsText: '',
      validationReference: 'test-ref',
      custodyCodes: [],
    };
    await expect(config.update('documents', 'admin', dto)).rejects.toThrow(
      'contrat validé',
    );
    f.query.getExists.mockResolvedValue(true);
    await expect(
      config.update('documents', 'admin', { ...dto, termsText: terms.text }),
    ).rejects.toThrow('existe déjà');
  });
});
