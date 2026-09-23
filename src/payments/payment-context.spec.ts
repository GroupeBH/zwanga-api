import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { loadPaymentContext, PaymentContextDto } from './payment-context';

const id = '00000000-0000-4000-8000-000000000001';
const at = '2026-09-23T09:00:00.000000';
function fixture() {
  const query = {
    where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), clone: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), addOrderBy: jest.fn().mockReturnThis(), take: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(), getCount: jest.fn().mockResolvedValue(26),
    getMany: jest.fn().mockResolvedValue([{ id }]), getRawAndEntities: jest.fn(),
  };
  return { query, repository: { createQueryBuilder: jest.fn().mockReturnValue(query) } as any };
}

describe('targeted payment reads', () => {
  it('booking receipt is account-scoped, includes legacy identifiers and returns only the newest payment', async () => {
    const f = fixture();
    expect(await loadPaymentContext(f.repository, 'account', { kind: 'booking', bookingId: id,
      reference: 'reference', tripId: id, transactionId: id })).toEqual([{ id }]);
    expect(f.query.where).toHaveBeenCalledWith('entry.userId = :userId', { userId: 'account' });
    expect(f.query.andWhere).toHaveBeenCalledWith('entry.purpose = :purpose', { purpose: 'trip_booking' });
    expect(f.query.andWhere).toHaveBeenCalledWith(expect.stringContaining('entry.relatedEntityId IN'),
      { identifiers: [id, id, 'reference', id] });
    expect(f.query.take).toHaveBeenCalledWith(1);
    expect(f.query.getCount).not.toHaveBeenCalled();
  });

  it('searches past declined attempts in bounded pages, preserving a valid older pending subscription', async () => {
    const f = fixture();
    const declined = { id, orderNumber: 'order', providerMessage: 'Transaction échouée', providerStatusCode: null };
    const valid = { ...declined, providerMessage: 'En attente de confirmation' };
    f.query.getRawAndEntities.mockResolvedValueOnce({ entities: Array(26).fill(declined),
      raw: Array(26).fill({ cursorTime: at }) }).mockResolvedValueOnce({ entities: [valid], raw: [{ cursorTime: at }] });
    const now = Date.parse('2026-09-23T09:00:00Z');
    expect(await loadPaymentContext(f.repository, 'account', { kind: 'subscription' }, now)).toEqual([valid]);
    expect(f.query.where).toHaveBeenCalledWith('entry.userId = :userId', { userId: 'account' });
    expect(f.query.andWhere).toHaveBeenCalledWith('entry.createdAt >= :since', { since: new Date(now - 30 * 60_000) });
    expect(f.query.andWhere).toHaveBeenCalledWith('entry.status IN (:...statuses)', { statuses: ['pending', 'initiated'] });
    expect(f.query.take).toHaveBeenCalledWith(26);
    expect(f.query.getRawAndEntities).toHaveBeenCalledTimes(2);
  });

  it('returns empty if no relevant payment exists, and propagates a database failure', async () => {
    const f = fixture();
    f.query.getRawAndEntities.mockResolvedValue({ entities: [], raw: [] });
    expect(await loadPaymentContext(f.repository, 'account', { kind: 'subscription' })).toEqual([]);
    f.query.getMany.mockRejectedValue(new Error('unavailable'));
    await expect(loadPaymentContext(f.repository, 'account', { kind: 'booking', bookingId: id })).rejects.toThrow('unavailable');
  });

  it('validates kinds and booking identifiers before executing queries', () => {
    const check = (value: unknown) => validateSync(plainToInstance(PaymentContextDto, value));
    expect(check({ kind: 'booking' })).not.toHaveLength(0);
    expect(check({ kind: 'booking', bookingId: 'invalid' })).not.toHaveLength(0);
    expect(check({ kind: 'all' })).not.toHaveLength(0);
    expect(check({ kind: 'subscription' })).toHaveLength(0);
    expect(check({ kind: 'booking', bookingId: id })).toHaveLength(0);
  });
});
