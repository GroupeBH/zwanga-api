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
import { AddReferralProgram1780000018000 } from './1780000018000-AddReferralProgram';
import { AddBranchReferralAttribution1780000019000 } from './1780000019000-AddBranchReferralAttribution';
import { ReplaceBranchWithChottuLink1780000020000 } from './1780000020000-ReplaceBranchWithChottuLink';
import { HardenTokenTripSettlements1780000021000 } from './1780000021000-HardenTokenTripSettlements';
import { HardenDriverPayouts1780000022000 } from './1780000022000-HardenDriverPayouts';
import { AddAdminWalletAdjustments1780000023000 } from './1780000023000-AddAdminWalletAdjustments';
import { AddAdminReferralReadIndexes1780000024000 } from './1780000024000-AddAdminReferralReadIndexes';
import { AddSuperAdminRole1780000025000 } from './1780000025000-AddSuperAdminRole';
import { AddAdminPasswordChangeRequired1780000026000 } from './1780000026000-AddAdminPasswordChangeRequired';
import { AddDiditKycFields1780000027000 } from './1780000027000-AddDiditKycFields';

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
  AddReferralProgram1780000018000,
  AddBranchReferralAttribution1780000019000,
  ReplaceBranchWithChottuLink1780000020000,
  HardenTokenTripSettlements1780000021000,
  HardenDriverPayouts1780000022000,
  AddAdminWalletAdjustments1780000023000,
  AddAdminReferralReadIndexes1780000024000,
  AddSuperAdminRole1780000025000,
  AddAdminPasswordChangeRequired1780000026000,
  AddDiditKycFields1780000027000,
];
