import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { WalletAccountType } from '../wallet/entities/wallet-account.entity';
import { WalletLedgerEntryType } from '../wallet/entities/wallet-ledger-entry.entity';

function createQueryBuilderMock() {
  const query = {
    leftJoinAndMapOne: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    select: jest.fn(),
    getManyAndCount: jest.fn(),
    getRawOne: jest.fn(),
  };
  for (const method of [
    'leftJoinAndMapOne',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'skip',
    'take',
    'select',
  ] as const) {
    query[method].mockReturnValue(query);
  }
  return query;
}

describe('AdminService wallet administration', () => {
  const userRepository = { findOne: jest.fn() };
  const walletAccountRepository = { createQueryBuilder: jest.fn() };
  const walletLedgerRepository = { createQueryBuilder: jest.fn() };
  const walletService = { applyAdminAdjustment: jest.fn() };
  let service: AdminService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminService(
      userRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      walletAccountRepository as any,
      walletLedgerRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      walletService as any,
    );
  });

  it('returns paginated token accounts with numeric balances and a global summary', async () => {
    const accountsQuery = createQueryBuilderMock();
    const summaryQuery = createQueryBuilderMock();
    const walletUser = {
      id: 'user-1',
      firstName: 'Aline',
      lastName: 'Mbuyi',
      phone: '+243810000000',
      email: 'aline@example.com',
      role: UserRole.PASSENGER,
      status: UserStatus.ACTIVE,
      isDriver: false,
      isActive: true,
      password: 'must-not-leak',
      accessToken: 'must-not-leak',
      refreshToken: 'must-not-leak',
    };
    accountsQuery.getManyAndCount.mockResolvedValue([
      [
        {
          id: 'wallet-1',
          userId: 'user-1',
          type: WalletAccountType.POINTS,
          balance: '75.50',
          currency: 'PTS',
          user: walletUser,
        },
      ],
      1,
    ]);
    summaryQuery.getRawOne.mockResolvedValue({
      accounts: '3',
      totalBalance: '125.50',
      positiveBalances: '2',
      negativeBalances: '0',
    });
    walletAccountRepository.createQueryBuilder
      .mockReturnValueOnce(accountsQuery)
      .mockReturnValueOnce(summaryQuery);

    const result = await service.getWalletAccounts(1, 25, 'Aline');

    expect(result.accounts[0].balance).toBe(75.5);
    expect(result.accounts[0].user).toEqual(
      expect.objectContaining({ id: 'user-1', firstName: 'Aline' }),
    );
    expect(result.accounts[0].user).not.toHaveProperty('password');
    expect(result.accounts[0].user).not.toHaveProperty('accessToken');
    expect(result.summary).toEqual({
      accounts: 3,
      totalBalance: 125.5,
      positiveBalances: 2,
      negativeBalances: 0,
      currency: 'PTS',
    });
    expect(accountsQuery.andWhere).toHaveBeenCalled();
  });

  it('returns numeric ledger amounts and rejects an unknown entry type', async () => {
    const ledgerQuery = createQueryBuilderMock();
    ledgerQuery.getManyAndCount.mockResolvedValue([
      [
        {
          id: 'entry-1',
          accountId: 'wallet-1',
          userId: 'user-1',
          accountType: WalletAccountType.POINTS,
          type: WalletLedgerEntryType.TOP_UP,
          amount: '25.00',
          balanceAfter: '75.00',
          currency: 'PTS',
          user: null,
        },
      ],
      1,
    ]);
    walletLedgerRepository.createQueryBuilder.mockReturnValue(ledgerQuery);

    const result = await service.getWalletLedger(
      1,
      25,
      undefined,
      WalletLedgerEntryType.TOP_UP,
    );

    expect(result.entries[0]).toEqual(
      expect.objectContaining({ amount: 25, balanceAfter: 75 }),
    );
    expect(ledgerQuery.andWhere).toHaveBeenCalledWith(
      'entry.type = :entryType',
      { entryType: WalletLedgerEntryType.TOP_UP },
    );
    await expect(
      service.getWalletLedger(1, 25, undefined, 'unknown'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
