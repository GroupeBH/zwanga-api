import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getMetadataArgsStorage } from 'typeorm';
import { BookingsService } from './bookings.service';
import { CashReceiptsService } from './cash-receipts.service';
import { Booking } from './entities/booking.entity';
import { AddCashReceipts1780000039000 } from '../database/migrations/1780000039000-AddCashReceipts';

const fixture = (patch = {}) => {
  const booking = { id: 'booking', trip: { driverId: 'driver' }, paymentMode: 'cash', paymentStatus: 'not_required',
    status: 'completed', droppedOff: true, paymentAmount: '2000.00', paymentCurrency: 'CDF', ...patch };
  const repository = { findOne: jest.fn(async () => booking), query: jest.fn(async () => [[{ id: 'booking' }], 1]) };
  const bookings = { invalidateManualRideCaches: jest.fn(async () => undefined), findOne: jest.fn(async () => booking) };
  const service = new CashReceiptsService(repository as never, bookings as never);
  return { service, repository, bookings, booking };
};

describe('explicit driver cash receipt', () => {
  it('rejects missing bookings and passengers/other drivers before any write', async () => {
    const env = fixture();
    await expect(env.service.confirm('booking', 'passenger', 2000, 'CDF')).rejects.toBeInstanceOf(ForbiddenException);
    expect(env.repository.query).not.toHaveBeenCalled();
    env.repository.findOne.mockResolvedValueOnce(null as never);
    await expect(env.service.confirm('booking', 'driver', 2000, 'CDF')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([{ status: 'accepted' }, { droppedOff: false }, { paymentMode: 'points' }, { paymentMode: 'electronic' }])(
    'rejects incomplete rides and non-cash payments: %p', async patch => {
      const env = fixture(patch);
      await expect(env.service.confirm('booking', 'driver', 2000, 'CDF')).rejects.toBeInstanceOf(BadRequestException);
      expect(env.repository.query).not.toHaveBeenCalled();
    });

  it.each([[1500, 'CDF'], [2000, 'USD'], [0, 'CDF'], [NaN, 'CDF']])(
    'rejects a stale or invalid amount/currency: %p %p', async (amount, currency) => {
      const env = fixture();
      await expect(env.service.confirm('booking', 'driver', amount as number, currency as string)).rejects.toBeInstanceOf(ConflictException);
      expect(env.repository.query).not.toHaveBeenCalled();
    });

  it('only writes receipt fields and invalidates caches; retries retain the first receipt', async () => {
    const env = fixture();
    await env.service.confirm('booking', 'driver', 2000, 'CDF');
    await env.service.confirm('booking', 'driver', 2000, 'CDF');
    const [sql, parameters] = env.repository.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(parameters).toEqual(['booking', 'driver', 2000, 'CDF']);
    expect(sql).toContain('COALESCE(b."cashReceivedAt", CURRENT_TIMESTAMP)');
    expect(sql).toContain('t."driverId" = $2::uuid');
    expect(sql).toContain('b."paymentStatus" = \'not_required\'');
    expect(sql).toContain('b."paymentAmount" = $3');
    expect(sql).toContain('b."paymentCurrency" = $4');
    expect(sql.slice(0, sql.indexOf('FROM trips'))).not.toMatch(/"paymentStatus"\s*=|"paymentAmount"\s*=|"paidAt"\s*=/);
    expect(env.bookings.invalidateManualRideCaches).toHaveBeenCalledWith('booking');
    expect(env.bookings.findOne).toHaveBeenCalledWith('booking');
  });

  it('fails safely if ownership/mode/amount changes between the read and the atomic write', async () => {
    const env = fixture(); env.repository.query.mockResolvedValueOnce([[], 0]);
    await expect(env.service.confirm('booking', 'driver', 2000, 'CDF')).rejects.toBeInstanceOf(ConflictException);
    expect(env.bookings.invalidateManualRideCaches).not.toHaveBeenCalled();
  });

  it('confirmed cash blocks a later switch to electronic payment', async () => {
    const env = fixture({ cashReceivedAt: new Date() });
    const service = Object.assign(Object.create(BookingsService.prototype), { bookingRepository: env.repository });
    await expect(service.updatePaymentMode('booking', 'passenger', 'electronic')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stale entity saves cannot erase receipts and schema has no historical auto-confirmation', async () => {
    const columns = getMetadataArgsStorage().columns.filter(column => column.target === Booking && column.propertyName.startsWith('cashReceived'));
    expect(columns).toHaveLength(3);
    expect(columns.every(column => column.options.update === false)).toBe(true);
    const sql: string[] = [];
    await new AddCashReceipts1780000039000().up({ query: async statement => { sql.push(statement); } } as never);
    expect(sql.join('\n')).toContain('timestamptz NULL');
    expect(sql.join('\n')).toContain('"CHK_booking_cash_receipt"');
    expect(sql.join('\n')).toContain('"cashReceivedAmount" = "paymentAmount"');
    expect(sql.join('\n')).not.toMatch(/UPDATE bookings|DEFAULT now\(\)/);
  });
});
