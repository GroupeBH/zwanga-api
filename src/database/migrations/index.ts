import { FillTotalSeats1780000000000 } from './1780000000000-FillTotalSeats';
import { PreventMultipleActiveDriverTrips1780000001000 } from './1780000001000-PreventMultipleActiveDriverTrips';
import { AddAppleIdToUsers1780000002000 } from './1780000002000-AddAppleIdToUsers';
import { AddBookingPayments1780000003000 } from './1780000003000-AddBookingPayments';
import { AddTripPaymentModes1780000005000 } from './1780000005000-AddTripPaymentModes';
import { AddWalletPointsAndDriverSettlements1780000006000 } from './1780000006000-AddWalletPointsAndDriverSettlements';

export const databaseMigrations = [
  FillTotalSeats1780000000000,
  PreventMultipleActiveDriverTrips1780000001000,
  AddAppleIdToUsers1780000002000,
  AddBookingPayments1780000003000,
  AddTripPaymentModes1780000005000,
  AddWalletPointsAndDriverSettlements1780000006000,
];
