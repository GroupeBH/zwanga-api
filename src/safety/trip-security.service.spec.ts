import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { NotificationService } from '../notifications/notifications.service';
import { BookingStatus } from '../bookings/entities/booking.entity';
import { TripStatus } from '../trips/entities/trip.entity';
import { TripSecurityService } from './trip-security.service';
import {
  TripSafetyParticipant,
  TripSafetyParticipantRole,
} from './entities/trip-safety-participant.entity';
import { TripSafetyStatus } from './entities/trip-safety-status.enum';
import {
  TripSafetyNotificationType,
} from './entities/trip-safety-notification.entity';
import { TripSafetyChannel } from './entities/trip-safety-channel.enum';
import { TripSafetyEventType } from './entities/trip-safety-event.entity';
import {
  TripSecurityConfirmationOutcome,
  TripSecurityStartAction,
} from './dto/trip-security.dto';

type MockRepo<T> = Partial<Record<keyof Repository<T>, jest.Mock>>;

const createRepositoryMock = <T>(): MockRepo<T> => ({
  findOne: jest.fn(),
  find: jest.fn(),
  save: jest.fn((payload) => payload),
  create: jest.fn((payload) => payload),
  delete: jest.fn(),
});

describe('TripSecurityService', () => {
  let service: TripSecurityService;

  let participantRepository: MockRepo<TripSafetyParticipant>;
  let participantContactRepository: MockRepo<any>;
  let participantEventRepository: MockRepo<any>;
  let participantNotificationRepository: MockRepo<any>;
  let emergencyContactRepository: MockRepo<any>;
  let safetyAlertRepository: MockRepo<any>;
  let userRepository: MockRepo<any>;
  let tripRepository: MockRepo<any>;
  let bookingRepository: MockRepo<any>;

  const notificationService = {
    sendNotification: jest.fn(),
  } as unknown as NotificationService;

  const whatsAppService = {
    sendMessage: jest.fn().mockResolvedValue(true),
  } as any;

  const configService = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        TRIP_SECURITY_NOTIFICATION_CHANNELS: 'push,sms,email',
        TRIP_SECURITY_REMINDER_DELAY_MINUTES: '10',
        TRIP_SECURITY_ESCALATION_DELAY_MINUTES: '15',
        TRIP_SECURITY_DEFAULT_ESTIMATED_DURATION_MINUTES: '90',
        TRIP_SECURITY_TRACKING_BASE_URL: 'https://zwanga.test/trip-security',
      };
      return values[key];
    }),
  } as unknown as ConfigService;

  beforeEach(() => {
    participantRepository = createRepositoryMock();
    participantContactRepository = createRepositoryMock();
    participantEventRepository = createRepositoryMock();
    participantNotificationRepository = createRepositoryMock();
    emergencyContactRepository = createRepositoryMock();
    safetyAlertRepository = createRepositoryMock();
    userRepository = createRepositoryMock();
    tripRepository = createRepositoryMock();
    bookingRepository = createRepositoryMock();

    service = new TripSecurityService(
      participantRepository as unknown as Repository<TripSafetyParticipant>,
      participantContactRepository as unknown as Repository<any>,
      participantEventRepository as unknown as Repository<any>,
      participantNotificationRepository as unknown as Repository<any>,
      emergencyContactRepository as unknown as Repository<any>,
      safetyAlertRepository as unknown as Repository<any>,
      userRepository as unknown as Repository<any>,
      tripRepository as unknown as Repository<any>,
      bookingRepository as unknown as Repository<any>,
      notificationService,
      whatsAppService,
      configService,
    );
  });

  it('starts individual tracking for driver and records monitoring lifecycle bootstrap', async () => {
    userRepository.findOne!.mockResolvedValue({
      id: 'driver-1',
      firstName: 'Driver',
      lastName: 'One',
      fcmToken: 'fcm-driver',
      phone: '+243000000001',
      email: 'driver@example.com',
    });
    tripRepository.findOne!.mockResolvedValue({
      id: 'trip-1',
      driverId: 'driver-1',
      departureDate: new Date(Date.now() + 30 * 60 * 1000),
    });

    participantRepository.findOne!.mockResolvedValue(null);
    participantRepository.save!.mockImplementation(async (payload) => ({
      id: payload.id ?? 'participant-1',
      ...payload,
    }));

    const syncContactsSpy = jest
      .spyOn(service as any, 'syncTrustedContacts')
      .mockResolvedValue(undefined);
    const boardedSpy = jest
      .spyOn(service as any, 'markBoardedAndInTransit')
      .mockResolvedValue(undefined);
    const notifyContactsSpy = jest
      .spyOn(service as any, 'notifyTrustedContactsInternal')
      .mockResolvedValue({ sent: 1, failed: 0, skipped: 0 });
    const logEventSpy = jest.spyOn(service as any, 'logEvent').mockResolvedValue(undefined);
    const getParticipantSpy = jest.spyOn(service, 'getParticipant').mockResolvedValue({
      id: 'participant-1',
      tripId: 'trip-1',
      bookingId: null,
      userId: 'driver-1',
      role: TripSafetyParticipantRole.DRIVER,
      status: TripSafetyStatus.IN_TRANSIT,
      startedAt: new Date(),
      boardedAt: new Date(),
      inTransitAt: new Date(),
      estimatedEndAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      tripEndedDetectedAt: null,
      droppedOffAt: null,
      arrivedAt: null,
      confirmedAt: null,
      completedAt: null,
      reminderSentAt: null,
      reminderCount: 0,
      escalatedAt: null,
      isEscalated: false,
      reminderDelayMinutes: 10,
      escalationDelayMinutes: 15,
      notificationChannels: [TripSafetyChannel.PUSH, TripSafetyChannel.SMS],
      trackingCode: 'TS-AAA-BBB',
      cancelledAt: null,
      trustedContacts: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.startTracking('driver-1', {
      tripId: 'trip-1',
      action: TripSecurityStartAction.TRIP_STARTED,
      notifyTrustedContacts: true,
    });

    expect(result.id).toBe('participant-1');
    expect(syncContactsSpy).toHaveBeenCalledTimes(1);
    expect(boardedSpy).toHaveBeenCalledTimes(1);
    expect(notifyContactsSpy).toHaveBeenCalledWith(
      expect.any(Object),
      TripSafetyNotificationType.BOARDING_SHARED,
      expect.any(Object),
    );
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.any(Object),
      TripSafetyEventType.TRACKING_CREATED,
      null,
      TripSafetyStatus.PENDING,
      expect.any(Object),
    );
    expect(getParticipantSpy).toHaveBeenCalledWith('participant-1', 'driver-1');
  });

  it('marks late confirmation flow as completed and logs late confirmation event', async () => {
    const participant: TripSafetyParticipant = {
      id: 'participant-2',
      participantRef: 'driver:trip-2:user:driver-2',
      tripId: 'trip-2',
      bookingId: null,
      userId: 'driver-2',
      role: TripSafetyParticipantRole.DRIVER,
      status: TripSafetyStatus.ARRIVAL_UNCONFIRMED,
      startedAt: new Date(),
      boardedAt: new Date(),
      inTransitAt: new Date(),
      estimatedEndAt: new Date(Date.now() - 60 * 60 * 1000),
      tripEndedDetectedAt: null,
      droppedOffAt: null,
      arrivedAt: null,
      confirmedAt: null,
      completedAt: null,
      reminderSentAt: new Date(Date.now() - 30 * 60 * 1000),
      reminderCount: 1,
      escalatedAt: null,
      isEscalated: false,
      notificationChannels: [TripSafetyChannel.PUSH],
      reminderDelayMinutes: 10,
      escalationDelayMinutes: 15,
      trackingCode: 'TS-LATE-001',
      cancelledAt: null,
      trustedContacts: [],
      events: [],
      notifications: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      trip: null as any,
      booking: null,
      user: null as any,
    };

    jest
      .spyOn(service as any, 'getOwnedParticipant')
      .mockResolvedValue(participant);
    participantRepository.save!.mockImplementation(async (payload) => payload);
    const logEventSpy = jest.spyOn(service as any, 'logEvent').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'notifyTrustedContactsInternal')
      .mockResolvedValue({ sent: 0, failed: 0, skipped: 1 });
    jest.spyOn(service, 'getParticipant').mockResolvedValue({
      ...(participant as unknown as any),
      status: TripSafetyStatus.COMPLETED,
      confirmedAt: new Date(),
      completedAt: new Date(),
      trustedContacts: [],
    });

    const result = await service.confirmParticipant('participant-2', 'driver-2', {
      outcome: TripSecurityConfirmationOutcome.ARRIVED,
      note: 'Arrive a destination',
    });

    expect(result.status).toBe(TripSafetyStatus.COMPLETED);
    expect(participantRepository.save).toHaveBeenCalledTimes(2);
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.any(Object),
      TripSafetyEventType.LATE_CONFIRMATION,
      TripSafetyStatus.ARRIVAL_UNCONFIRMED,
      TripSafetyStatus.COMPLETED,
      expect.any(Object),
    );
  });

  it('processes reminder and escalation independently for multiple participants', async () => {
    const participantNeedingReminder: TripSafetyParticipant = {
      id: 'participant-reminder',
      participantRef: 'driver:trip-3:user:driver-3',
      tripId: 'trip-3',
      bookingId: null,
      userId: 'driver-3',
      role: TripSafetyParticipantRole.DRIVER,
      status: TripSafetyStatus.IN_TRANSIT,
      startedAt: new Date(),
      boardedAt: new Date(),
      inTransitAt: new Date(),
      estimatedEndAt: new Date(Date.now() - 90 * 60 * 1000),
      tripEndedDetectedAt: null,
      droppedOffAt: null,
      arrivedAt: null,
      confirmedAt: null,
      completedAt: null,
      reminderSentAt: null,
      reminderCount: 0,
      escalatedAt: null,
      isEscalated: false,
      notificationChannels: [TripSafetyChannel.PUSH],
      reminderDelayMinutes: 10,
      escalationDelayMinutes: 15,
      trackingCode: 'TS-REMINDER',
      cancelledAt: null,
      trustedContacts: [],
      events: [],
      notifications: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      trip: { id: 'trip-3', status: TripStatus.ACTIVE } as any,
      booking: null,
      user: null as any,
    };

    const participantNeedingEscalation: TripSafetyParticipant = {
      ...participantNeedingReminder,
      id: 'participant-escalation',
      participantRef: 'booking:booking-1:user:passenger-1',
      userId: 'passenger-1',
      role: TripSafetyParticipantRole.PASSENGER,
      bookingId: 'booking-1',
      status: TripSafetyStatus.DROPOFF_UNCONFIRMED,
      reminderSentAt: new Date(Date.now() - 45 * 60 * 1000),
      reminderCount: 1,
      trackingCode: 'TS-ESCALATION',
      trip: { id: 'trip-3', status: TripStatus.COMPLETED } as any,
      booking: { id: 'booking-1', status: BookingStatus.ACCEPTED } as any,
    };

    participantRepository.find!.mockResolvedValue([
      participantNeedingReminder,
      participantNeedingEscalation,
    ]);

    jest.spyOn(service as any, 'shouldMarkTripAsEnded').mockResolvedValue(false);
    const sendReminderSpy = jest.spyOn(service as any, 'sendReminder').mockResolvedValue(undefined);
    const escalateSpy = jest
      .spyOn(service as any, 'triggerEscalation')
      .mockResolvedValue({ sent: 2, failed: 0, skipped: 0 });

    const result = await service.processAutomaticFollowUps();

    expect(sendReminderSpy).toHaveBeenCalledTimes(1);
    expect(sendReminderSpy).toHaveBeenCalledWith(participantNeedingReminder, 'eta_exceeded');
    expect(escalateSpy).toHaveBeenCalledTimes(1);
    expect(escalateSpy).toHaveBeenCalledWith(
      participantNeedingEscalation,
      'no_confirmation_after_reminder',
    );
    expect(result.processed).toBe(2);
    expect(result.reminders).toBe(1);
    expect(result.escalations).toBe(1);
  });
});
