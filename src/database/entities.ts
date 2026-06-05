import { User } from '../users/entities/user.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { Trip } from '../trips/entities/trip.entity';
import { RecurringTripTemplate } from '../trips/entities/recurring-trip-template.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Message } from '../chat/entities/message.entity';
import { Rating } from '../ratings/entities/rating.entity';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { DocumentFundingRequest } from '../subscriptions/entities/document-funding-request.entity';
import { Conversation } from '../chat/entities/conversation.entity';
import { ConversationParticipant } from '../chat/entities/conversation-participant.entity';
import { FaqEntry } from '../faq/entities/faq-entry.entity';
import { TripRequest } from '../trip-requests/entities/trip-request.entity';
import { DriverOffer } from '../trip-requests/entities/driver-offer.entity';
import { EmergencyContact } from '../safety/entities/emergency-contact.entity';
import { SafetyAlert } from '../safety/entities/safety-alert.entity';
import { UserReport } from '../safety/entities/user-report.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { FavoriteLocation } from '../users/entities/favorite-location.entity';
import { FavoritePlace } from '../favorite-places/entities/favorite-place.entity';
import { SupportTicket } from '../support/entities/support-ticket.entity';
import { SupportTicketMessage } from '../support/entities/support-ticket-message.entity';

export const typeOrmEntities = [
  User,
  KycDocument,
  Vehicle,
  Trip,
  RecurringTripTemplate,
  Booking,
  Message,
  Rating,
  PaymentTransaction,
  Subscription,
  DocumentFundingRequest,
  Conversation,
  ConversationParticipant,
  FaqEntry,
  TripRequest,
  DriverOffer,
  EmergencyContact,
  SafetyAlert,
  UserReport,
  Notification,
  FavoritePlace,
  FavoriteLocation,
  SupportTicket,
  SupportTicketMessage,
];
