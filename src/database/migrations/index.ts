import { FillTotalSeats1780000000000 } from './1780000000000-FillTotalSeats';
import { PreventMultipleActiveDriverTrips1780000001000 } from './1780000001000-PreventMultipleActiveDriverTrips';
import { AddAppleIdToUsers1780000002000 } from './1780000002000-AddAppleIdToUsers';
import { AddBookingPayments1780000003000 } from './1780000003000-AddBookingPayments';
import { AddTripPaymentModes1780000005000 } from './1780000005000-AddTripPaymentModes';
import { AddWalletPointsAndDriverSettlements1780000006000 } from './1780000006000-AddWalletPointsAndDriverSettlements';
import { AddTripShareLinks1780000007000 } from './1780000007000-AddTripShareLinks';
import { AddRideArrivalTrackingState1780000008000 } from './1780000008000-AddRideArrivalTrackingState';
import { RepairDriverPickupArrivedAt1780000009000 } from './1780000009000-RepairDriverPickupArrivedAt';

export const databaseMigrations = [
  FillTotalSeats1780000000000,
  PreventMultipleActiveDriverTrips1780000001000,
  AddAppleIdToUsers1780000002000,
  AddBookingPayments1780000003000,
  AddTripPaymentModes1780000005000,
  AddWalletPointsAndDriverSettlements1780000006000,
  AddTripShareLinks1780000007000,
  AddRideArrivalTrackingState1780000008000,
  RepairDriverPickupArrivedAt1780000009000,
];
