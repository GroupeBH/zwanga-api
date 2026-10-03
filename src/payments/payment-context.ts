import { IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import type { Repository } from 'typeorm';
import { PaymentTransaction } from './entities/payment-transaction.entity';
import { loadHistoryPage } from '../common/pagination/history-page';

export class PaymentContextDto {
  @IsIn(['booking', 'subscription'])
  kind: 'booking' | 'subscription';

  @ValidateIf(value => value.kind === 'booking') @IsUUID()
  bookingId?: string;

  @IsOptional() @IsString() @MaxLength(120)
  reference?: string;

  @IsOptional() @IsUUID()
  tripId?: string;

  @IsOptional() @IsUUID()
  transactionId?: string;
}

const RECENT_PENDING_MS = 30 * 60 * 1000;
function declined(message: string | null) {
  const normalized = (message ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /annul|cancel|declined|echec|echoue|failed|failure|refuse|rejet|non abouti|not complet|not successful|solde insuffisant|unsuccessful|insufficient/.test(normalized);
}

/** Read-only, account-scoped lookup. Never returns provider payloads to the controller. */
export async function loadPaymentContext(repository: Repository<PaymentTransaction>, userId: string,
  context: PaymentContextDto, now = Date.now()): Promise<PaymentTransaction[]> {
  const query = repository.createQueryBuilder('entry').where('entry.userId = :userId', { userId });
  if (context.kind === 'booking') {
    const identifiers = [context.bookingId, context.tripId, context.reference, context.transactionId].filter(Boolean);
    query.andWhere('entry.purpose = :purpose', { purpose: 'trip_booking' })
      .andWhere('(entry.relatedEntityId IN (:...identifiers) OR entry.reference IN (:...identifiers) OR entry.orderNumber IN (:...identifiers))', { identifiers });
    return query.orderBy('entry.createdAt', 'DESC').addOrderBy('entry.id', 'DESC').take(1).getMany();
  }
  query.andWhere('entry.purpose = :purpose', { purpose: 'subscription_pro' })
    .andWhere('entry.status IN (:...statuses)', { statuses: ['pending', 'initiated'] })
    .andWhere('entry.createdAt >= :since', { since: new Date(now - RECENT_PENDING_MS) })
    .andWhere('entry.orderNumber IS NOT NULL');
  // Skip stale operator-declined records without arbitrarily losing a valid older attempt.
  let before: string | undefined;
  do {
    const page = await loadHistoryPage(query.clone(), { before, limit: 25 });
    const pending = page.data.find(item => item.orderNumber && !declined(item.providerMessage) && !declined(item.providerStatusCode));
    if (pending) return [pending];
    before = page.nextCursor ?? undefined;
  } while (before);
  return [];
}
