import { ConflictException, ForbiddenException } from '@nestjs/common';
import { assertNoUnfinishedBoarding } from './account-lifecycle.service';
import { assertAccountAvailable, lockAvailableAccounts } from './account-availability';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { UserStatus } from './entities/user.entity';

describe('account resource lifecycle safety', () => {
  it.each(['pickedUp', 'pickedUpAt', 'pickedUpConfirmedByPassenger', 'pickedUpConfirmedAt'])(
    'blocks account retirement after %s until booking closure', field => {
      expect(() => assertNoUnfinishedBoarding([{ status: BookingStatus.ACCEPTED, [field]: true } as unknown as Booking]))
        .toThrow(ConflictException);
    });
  it.each(['driver', 'passenger'])('blocks a pending %s boarding declaration too', role => {
    expect(() => assertNoUnfinishedBoarding([{ status: BookingStatus.ACCEPTED,
      rideDeclarations: { pickup: { [role]: { decision: 'confirm' } } } } as unknown as Booking])).toThrow(ConflictException);
  });
  it('blocks uncertain boarding, but preserves completed history', () => {
    expect(() => assertNoUnfinishedBoarding([{ status: BookingStatus.BOARDING_UNCERTAIN } as Booking])).toThrow(ConflictException);
    expect(() => assertNoUnfinishedBoarding([{ status: BookingStatus.COMPLETED, pickedUp: true } as Booking])).not.toThrow();
  });
  it('allows an unboarded reservation to be retired', () => {
    expect(() => assertNoUnfinishedBoarding([{ status: BookingStatus.ACCEPTED } as Booking])).not.toThrow();
  });
  it.each([null, { isActive: false, status: UserStatus.ACTIVE },
    { isActive: true, status: UserStatus.INACTIVE }, { isActive: true, status: UserStatus.SUSPENDED }])('rejects unavailable owner %j', user => {
    expect(() => assertAccountAvailable(user)).toThrow(ForbiddenException);
  });
  it('does not confuse pending KYC with account deactivation', () => {
    expect(() => assertAccountAvailable({ isActive: true, status: UserStatus.PENDING_KYC })).not.toThrow();
  });
  it('takes deduplicated owner locks in deterministic order', async () => {
    const findOne = jest.fn().mockResolvedValue({ isActive: true, status: UserStatus.ACTIVE });
    await lockAvailableAccounts({ findOne } as any, ['b', 'a', 'b']);
    expect(findOne.mock.calls.map(call => call[1].where.id)).toEqual(['a', 'b']);
    expect(findOne.mock.calls[0][1].lock).toEqual({ mode: 'for_no_key_update' });
  });
});
