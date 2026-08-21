import { FillTotalSeats1780000000000 } from './1780000000000-FillTotalSeats';
import { PreventMultipleActiveDriverTrips1780000001000 } from './1780000001000-PreventMultipleActiveDriverTrips';
import { AddAppleIdToUsers1780000002000 } from './1780000002000-AddAppleIdToUsers';
import { AddBookingPayments1780000003000 } from './1780000003000-AddBookingPayments';
import { AddTripPaymentModes1780000005000 } from './1780000005000-AddTripPaymentModes';
import { AddWalletPointsAndDriverSettlements1780000006000 } from './1780000006000-AddWalletPointsAndDriverSettlements';
import { AddTripShareLinks1780000007000 } from './1780000007000-AddTripShareLinks';
import { AddRideArrivalTrackingState1780000008000 } from './1780000008000-AddRideArrivalTrackingState';
import { RepairDriverPickupArrivedAt1780000009000 } from './1780000009000-RepairDriverPickupArrivedAt';
import { AddTripInterruptionRequests1780000010000 } from './1780000010000-AddTripInterruptionRequests';
import { AddDistanceBasedBookingFares1780000011000 } from './1780000011000-AddDistanceBasedBookingFares';
import { AddWalletTransfersAndSubscriptionPayments1780000012000 } from './1780000012000-AddWalletTransfersAndSubscriptionPayments';
import { AddGenderToUsers1780000013000 } from './1780000013000-AddGenderToUsers';
import { AddVehicleTypes1780000014000 } from './1780000014000-AddVehicleTypes';
import { AddVehicleTypeToTripRequests1780000015000 } from './1780000015000-AddVehicleTypeToTripRequests';
import { AddSubscriptionTokenRewards1780000016000 } from './1780000016000-AddSubscriptionTokenRewards';
import { AddBookingNoShowState1780000017000 } from './1780000017000-AddBookingNoShowState';

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
  AddTripInterruptionRequests1780000010000,
  AddDistanceBasedBookingFares1780000011000,
  AddWalletTransfersAndSubscriptionPayments1780000012000,
  AddGenderToUsers1780000013000,
  AddVehicleTypes1780000014000,
  AddVehicleTypeToTripRequests1780000015000,
  AddSubscriptionTokenRewards1780000016000,
  AddBookingNoShowState1780000017000,
];
