import { ForbiddenException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletAccount } from './entities/wallet-account.entity';
import { WalletLedgerEntry } from './entities/wallet-ledger-entry.entity';
import { User, UserRole } from '../users/entities/user.entity';

describe('Admin wallet adjustment safeguards', () => {
  const reason = 'Correction justifiée par le support';
  const requestId = '123e4567-e89b-12d3-a456-426614174000';
  function fixture(balance: number | null = 100, purchased = 80) {
    const account =
      balance === null
        ? null
        : Object.assign(new WalletAccount(), {
            id: 'wallet',
            userId: 'user',
            type: 'points',
            balance,
            withdrawableBalance: purchased,
            reservedWithdrawalBalance: 5,
            currency: 'PTS',
          });
    const entry: { current: any } = { current: null };
    const users = {
      findOne: jest.fn(async ({ where }) => ({
        id: where.id,
        role: where.id === 'admin' ? UserRole.SUPER_ADMIN : UserRole.PASSENGER,
      })),
    };
    const manager = {
      findOne: jest.fn(async (entity) =>
        entity === WalletAccount
          ? account
          : entity === WalletLedgerEntry
            ? entry.current
            : { id: 'user' },
      ),
      create: jest.fn((entity, data) => Object.assign(new entity(), data)),
      save: jest.fn(async (data) => data),
    };
    const source = { transaction: jest.fn((callback) => callback(manager)) };
    const service = new WalletService(
      {} as any,
      {} as any,
      users as any,
      source as any,
      { get: jest.fn() } as any,
      {} as any,
    );
    return { service, account, entry, users, manager, source };
  }
  it('creates an empty wallet for a first promotional credit and locks its owner first', async () => {
    const f = fixture(null);
    const result = await f.service.applyAdminAdjustment(
      'admin',
      'user',
      25,
      reason,
      requestId,
    );
    expect(result.balance).toBe(25);
    expect(result.withdrawableBalance).toBe(0);
    expect(f.manager.findOne.mock.calls[0][0]).toBe(User);
    expect(f.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin_adjustment',
        amount: 25,
        withdrawableAmount: 0,
      }),
    );
  });
  it('debits promotional tokens first, preserving reserved funds', async () => {
    const f = fixture();
    const result = await f.service.applyAdminAdjustment(
      'admin',
      'user',
      -30,
      reason,
      requestId,
    );
    expect(result).toMatchObject({
      balance: 70,
      withdrawableBalance: 70,
      reservedWithdrawalBalance: 5,
    });
    expect(f.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin_adjustment',
        amount: -30,
        withdrawableAmount: -10,
      }),
    );
  });
  it('refuses an excessive debit without a new ledger entry', async () => {
    const f = fixture();
    await expect(
      f.service.applyAdminAdjustment('admin', 'user', -101, reason, requestId),
    ).rejects.toThrow('insuffisant');
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('refuses debits on a blocked wallet', async () => {
    const f = fixture();
    f.account!.withdrawalsBlocked = true;
    await expect(
      f.service.applyAdminAdjustment('admin', 'user', -1, reason, requestId),
    ).rejects.toThrow('vérification');
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it.each([0, NaN, Infinity, 1.001, 1000001, -1000001])(
    'refuses invalid amount %s',
    async (amount) => {
      const f = fixture();
      await expect(
        f.service.applyAdminAdjustment(
          'admin',
          'user',
          amount,
          reason,
          requestId,
        ),
      ).rejects.toThrow();
      expect(f.source.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    { amount: 26 },
    { userId: 'other' },
    { description: 'another operation' },
  ])(
    'rejects reused request IDs with changed parameters: %j',
    async (override) => {
      const f = fixture();
      f.entry.current = {
        userId: 'user',
        amount: 25,
        description: `Ajustement par admin admin: ${reason}`,
        ...override,
      };
      await expect(
        f.service.applyAdminAdjustment('admin', 'user', 25, reason, requestId),
      ).rejects.toThrow('autre ajustement');
      expect(f.manager.save).not.toHaveBeenCalled();
    },
  );
  it('preserves the super-admin requirement', async () => {
    const f = fixture();
    await expect(
      f.service.applyAdminAdjustment('user', 'user', 25, reason, requestId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.source.transaction).not.toHaveBeenCalled();
  });
});
