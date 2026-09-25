import type { Repository } from 'typeorm';
import { loadHistoryPage, type HistoryPageDto } from '../common/pagination/history-page';
import { WalletAccountType } from './entities/wallet-account.entity';
import type { WalletLedgerEntry } from './entities/wallet-ledger-entry.entity';

export function loadWalletLedgerPage(repository: Repository<WalletLedgerEntry>, userId: string, options: HistoryPageDto) {
  const query = repository.createQueryBuilder('entry')
    .where('entry.userId = :userId', { userId })
    .andWhere('entry.accountType = :accountType', { accountType: WalletAccountType.POINTS });
  return loadHistoryPage(query, options);
}
