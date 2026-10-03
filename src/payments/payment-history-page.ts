import type { Repository } from 'typeorm';
import { loadHistoryPage, type PaymentHistoryPageDto } from '../common/pagination/history-page';
import { PaymentTransaction } from './entities/payment-transaction.entity';

export function loadPaymentHistoryPage(repository: Repository<PaymentTransaction>, userId: string, options: PaymentHistoryPageDto) {
  const query = repository.createQueryBuilder('entry').where('entry.userId = :userId', { userId });
  const statuses = options.filter === 'pending' ? ['pending', 'initiated'] :
    options.filter === 'failed' ? ['failed', 'cancelled'] : options.filter === 'succeeded' ? ['succeeded'] : null;
  if (statuses) query.andWhere('entry.status IN (:...statuses)', { statuses });
  return loadHistoryPage(query, options);
}

export async function loadPaymentHistorySummary(repository: Repository<PaymentTransaction>, userId: string) {
  const query = repository.createQueryBuilder('entry').where('entry.userId = :userId', { userId });
  const [total, totals] = await Promise.all([
    query.clone().getCount(),
    query.clone().andWhere('entry.status = :status', { status: 'succeeded' })
      .select('entry.currency', 'currency').addSelect('SUM(entry.amount)', 'amount')
      .groupBy('entry.currency').getRawMany<{ currency: string; amount: string }>(),
  ]);
  return { total, succeededByCurrency: totals.map(row => ({ currency: row.currency, amount: Number(row.amount) })) };
}
