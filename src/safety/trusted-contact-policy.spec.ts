import { trustedContactMessagesEnabled } from './trusted-contact-policy';
import { BookingsService } from '../bookings/bookings.service';
import { TripsService } from '../trips/trips.service';

describe('manual sharing replaces automated relative messages', () => {
  it('disables contact delivery before any database access or external message, including saved contacts', async () => {
    expect(trustedContactMessagesEnabled()).toBe(false);
    const bookings = Object.create(BookingsService.prototype);
    const trips = Object.create(TripsService.prototype);
    // No repositories/providers: entering the former delivery path would throw.
    await bookings.notifySelectedEmergencyContacts({ safetyEmergencyContactIds: ['saved-contact'] }, 'pickup');
    await bookings.notifyDriverEmergencyContactsOnPickup({});
    await trips.notifyDriverEmergencyContacts({ driverSafetyEmergencyContactIds: ['saved-contact'] }, 'trip_started');
    await trips.notifyEmergencyContactsForMissingDropoff({}, [{}]);
  });
});
