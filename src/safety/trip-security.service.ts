import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { NotificationService } from '../notifications/notifications.service';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { EmergencyContact } from './entities/emergency-contact.entity';
import { SafetyAlert, SafetyAlertStatus, SafetyAlertType } from './entities/safety-alert.entity';
import {
  TripSafetyParticipant,
  TripSafetyParticipantRole,
} from './entities/trip-safety-participant.entity';
import { TripSafetyStatus } from './entities/trip-safety-status.enum';
import { TripSafetyContact } from './entities/trip-safety-contact.entity';
import { TripSafetyEvent, TripSafetyEventType } from './entities/trip-safety-event.entity';
import {
  TripSafetyNotification,
  TripSafetyNotificationStatus,
  TripSafetyNotificationType,
} from './entities/trip-safety-notification.entity';
import { TripSafetyChannel } from './entities/trip-safety-channel.enum';
import {
  CancelTripSecurityDto,
  ConfirmTripSecurityDto,
  ManualEscalationDto,
  NotifyTrustedContactsDto,
  StartTripSecurityTrackingDto,
  TripSecurityConfirmationOutcome,
  TripSecurityStartAction,
  UpdateTripSecurityConfigurationDto,
} from './dto/trip-security.dto';

export interface TripSafetyTrustedContactView {
  id: string;
  emergencyContactId: string;
  name: string;
  phone: string;
  email: string | null;
  channels: TripSafetyChannel[];
  lastNotifiedAt: Date | null;
}

export interface TripSafetyParticipantView {
  id: string;
  tripId: string;
  bookingId: string | null;
  userId: string;
  role: TripSafetyParticipantRole;
  status: TripSafetyStatus;
  startedAt: Date | null;
  boardedAt: Date | null;
  inTransitAt: Date | null;
  estimatedEndAt: Date | null;
  tripEndedDetectedAt: Date | null;
  droppedOffAt: Date | null;
  arrivedAt: Date | null;
  confirmedAt: Date | null;
  completedAt: Date | null;
  reminderSentAt: Date | null;
  reminderCount: number;
  escalatedAt: Date | null;
  isEscalated: boolean;
  reminderDelayMinutes: number;
  escalationDelayMinutes: number;
  notificationChannels: TripSafetyChannel[];
  trackingCode: string;
  cancelledAt: Date | null;
  trustedContacts: TripSafetyTrustedContactView[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TripSafetyHistoryView {
  participant: TripSafetyParticipantView;
  events: Array<{
    id: string;
    type: TripSafetyEventType;
    previousStatus: TripSafetyStatus | null;
    nextStatus: TripSafetyStatus | null;
    metadata: Record<string, unknown> | null;
    occurredAt: Date;
  }>;
  notifications: Array<{
    id: string;
    notificationType: TripSafetyNotificationType;
    channel: TripSafetyChannel;
    recipient: string;
    status: TripSafetyNotificationStatus;
    errorMessage: string | null;
    sentAt: Date | null;
    createdAt: Date;
  }>;
}

interface ParticipantContext {
  trip: Trip;
  booking: Booking | null;
  user: User;
  role: TripSafetyParticipantRole;
  participantRef: string;
}

export interface NotificationDispatchResult {
  sent: number;
  failed: number;
  skipped: number;
}

interface TrackingMessageContext {
  participant: TripSafetyParticipant;
  trip: Trip;
  booking: Booking | null;
  participantUser: User;
  driver: User | null;
}

@Injectable()
export class TripSecurityService {
  private readonly logger = new Logger(TripSecurityService.name);

  constructor(
    @InjectRepository(TripSafetyParticipant)
    private readonly participantRepository: Repository<TripSafetyParticipant>,
    @InjectRepository(TripSafetyContact)
    private readonly participantContactRepository: Repository<TripSafetyContact>,
    @InjectRepository(TripSafetyEvent)
    private readonly participantEventRepository: Repository<TripSafetyEvent>,
    @InjectRepository(TripSafetyNotification)
    private readonly participantNotificationRepository: Repository<TripSafetyNotification>,
    @InjectRepository(EmergencyContact)
    private readonly emergencyContactRepository: Repository<EmergencyContact>,
    @InjectRepository(SafetyAlert)
    private readonly safetyAlertRepository: Repository<SafetyAlert>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Trip)
    private readonly tripRepository: Repository<Trip>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    private readonly notificationService: NotificationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly configService: ConfigService,
  ) {}

  async startTracking(
    userId: string,
    dto: StartTripSecurityTrackingDto,
  ): Promise<TripSafetyParticipantView> {
    const context = await this.resolveParticipantContext(userId, dto.tripId, dto.bookingId);
    const channels = this.resolveChannels(dto.channels);
    const reminderDelayMinutes = dto.reminderDelayMinutes ?? this.defaultReminderDelayMinutes();
    const escalationDelayMinutes =
      dto.escalationDelayMinutes ?? this.defaultEscalationDelayMinutes();
    const estimatedEndAt =
      dto.estimatedEndAt !== undefined
        ? new Date(dto.estimatedEndAt)
        : this.computeDefaultEstimatedEnd(context.trip);

    if (estimatedEndAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        'La fin estimée du trajet doit être postérieure à l’heure actuelle',
      );
    }

    let participant = await this.participantRepository.findOne({
      where: { participantRef: context.participantRef },
      relations: ['trustedContacts'],
    });

    if (!participant) {
      participant = this.participantRepository.create({
        participantRef: context.participantRef,
        tripId: context.trip.id,
        bookingId: context.booking?.id ?? null,
        userId: context.user.id,
        role: context.role,
        status: TripSafetyStatus.PENDING,
        estimatedEndAt,
        reminderDelayMinutes,
        escalationDelayMinutes,
        notificationChannels: channels,
        trackingCode: this.generateTrackingCode(),
      });
      participant = await this.participantRepository.save(participant);

      await this.logEvent(
        participant,
        TripSafetyEventType.TRACKING_CREATED,
        null,
        participant.status,
        {
          startedByUserId: userId,
          action: dto.action ?? TripSecurityStartAction.IM_BOARDED,
          reminderDelayMinutes,
          escalationDelayMinutes,
          channels,
        },
      );
    } else {
      participant.estimatedEndAt = estimatedEndAt;
      participant.reminderDelayMinutes = reminderDelayMinutes;
      participant.escalationDelayMinutes = escalationDelayMinutes;
      participant.notificationChannels = channels;
      participant.cancelledAt = null;
      participant = await this.participantRepository.save(participant);
    }

    await this.syncTrustedContacts(
      participant,
      userId,
      dto.trustedContactIds,
      channels,
      true,
    );

    await this.markBoardedAndInTransit(
      participant,
      dto.action ?? TripSecurityStartAction.IM_BOARDED,
    );

    if (dto.notifyTrustedContacts !== false) {
      await this.notifyTrustedContactsInternal(
        participant,
        TripSafetyNotificationType.BOARDING_SHARED,
        {
          channels,
          trustedContactIds: dto.trustedContactIds,
        },
      );
    }

    return this.getParticipant(participant.id, userId);
  }

  async notifyTrustedContacts(
    participantId: string,
    userId: string,
    dto: NotifyTrustedContactsDto,
  ): Promise<{ participant: TripSafetyParticipantView; notificationStats: NotificationDispatchResult }> {
    const participant = await this.getOwnedParticipant(participantId, userId, true);
    const channels = this.resolveChannels(dto.channels ?? participant.notificationChannels);

    await this.syncTrustedContacts(
      participant,
      userId,
      dto.trustedContactIds,
      channels,
      dto.trustedContactIds !== undefined,
    );

    const notificationStats = await this.notifyTrustedContactsInternal(
      participant,
      TripSafetyNotificationType.BOARDING_SHARED,
      {
        channels,
        trustedContactIds: dto.trustedContactIds,
        customMessage: dto.customMessage,
      },
    );

    return {
      participant: await this.getParticipant(participant.id, userId),
      notificationStats,
    };
  }

  async confirmParticipant(
    participantId: string,
    userId: string,
    dto: ConfirmTripSecurityDto,
  ): Promise<TripSafetyParticipantView> {
    let participant = await this.getOwnedParticipant(participantId, userId);
    const now = new Date();
    const previousStatus = participant.status;
    const wasLateConfirmation = this.isUnconfirmedStatus(previousStatus);

    if (participant.completedAt && participant.confirmedAt) {
      return this.sanitizeParticipant(participant, true);
    }

    this.validateConfirmationOutcome(participant, dto.outcome);

    if (
      dto.outcome === TripSecurityConfirmationOutcome.DROPPED_OFF ||
      (dto.outcome === TripSecurityConfirmationOutcome.TRIP_ENDED &&
        participant.role === TripSafetyParticipantRole.PASSENGER)
    ) {
      participant.droppedOffAt = now;
      participant.status = TripSafetyStatus.DROPPED_OFF;
      participant = await this.participantRepository.save(participant);
      await this.logEvent(
        participant,
        TripSafetyEventType.STATUS_CHANGED,
        previousStatus,
        participant.status,
        { outcome: dto.outcome },
      );
    } else {
      participant.arrivedAt = now;
      participant.status = TripSafetyStatus.ARRIVED;
      participant = await this.participantRepository.save(participant);
      await this.logEvent(
        participant,
        TripSafetyEventType.STATUS_CHANGED,
        previousStatus,
        participant.status,
        { outcome: dto.outcome },
      );
    }

    participant.confirmedAt = now;
    participant.completedAt = now;
    participant.status = TripSafetyStatus.COMPLETED;
    participant = await this.participantRepository.save(participant);

    await this.logEvent(
      participant,
      TripSafetyEventType.CONFIRMATION_RECEIVED,
      null,
      participant.status,
      {
        outcome: dto.outcome,
        note: dto.note ?? null,
      },
    );

    if (wasLateConfirmation) {
      await this.logEvent(
        participant,
        TripSafetyEventType.LATE_CONFIRMATION,
        previousStatus,
        participant.status,
        {
          confirmedAt: now.toISOString(),
        },
      );
    }

    await this.notifyTrustedContactsInternal(
      participant,
      TripSafetyNotificationType.CONFIRMATION,
      {},
    );

    return this.getParticipant(participant.id, userId);
  }

  async updateParticipantConfiguration(
    participantId: string,
    userId: string,
    dto: UpdateTripSecurityConfigurationDto,
  ): Promise<TripSafetyParticipantView> {
    const participant = await this.getOwnedParticipant(participantId, userId);

    if (dto.reminderDelayMinutes !== undefined) {
      participant.reminderDelayMinutes = dto.reminderDelayMinutes;
    }

    if (dto.escalationDelayMinutes !== undefined) {
      participant.escalationDelayMinutes = dto.escalationDelayMinutes;
    }

    if (dto.channels !== undefined) {
      participant.notificationChannels = this.resolveChannels(dto.channels);
    }

    await this.participantRepository.save(participant);

    await this.logEvent(
      participant,
      TripSafetyEventType.STATUS_CHANGED,
      participant.status,
      participant.status,
      {
        configurationUpdated: true,
        reminderDelayMinutes: participant.reminderDelayMinutes,
        escalationDelayMinutes: participant.escalationDelayMinutes,
        channels: participant.notificationChannels,
      },
    );

    return this.getParticipant(participant.id, userId);
  }

  async escalateParticipant(
    participantId: string,
    userId: string,
    dto: ManualEscalationDto,
  ): Promise<{ participant: TripSafetyParticipantView; notificationStats: NotificationDispatchResult }> {
    const participant = await this.getOwnedParticipant(participantId, userId);
    const channels = this.resolveChannels(dto.channels ?? participant.notificationChannels);

    const notificationStats = await this.triggerEscalation(
      participant,
      'manual_escalation',
      channels,
      dto.reason,
    );

    return {
      participant: await this.getParticipant(participant.id, userId),
      notificationStats,
    };
  }

  async cancelTracking(
    participantId: string,
    userId: string,
    dto: CancelTripSecurityDto,
  ): Promise<TripSafetyParticipantView> {
    const participant = await this.getOwnedParticipant(participantId, userId);
    const previousStatus = participant.status;
    const now = new Date();

    participant.cancelledAt = now;
    participant.completedAt = participant.completedAt ?? now;
    participant.status = TripSafetyStatus.COMPLETED;
    await this.participantRepository.save(participant);

    await this.logEvent(
      participant,
      TripSafetyEventType.MONITORING_CANCELLED,
      previousStatus,
      participant.status,
      { reason: dto.reason ?? null },
    );

    return this.getParticipant(participant.id, userId);
  }

  async getParticipant(
    participantId: string,
    userId: string,
  ): Promise<TripSafetyParticipantView> {
    const participant = await this.getOwnedParticipant(participantId, userId, true);
    return this.sanitizeParticipant(participant, true);
  }

  async getParticipantHistory(
    participantId: string,
    userId: string,
  ): Promise<TripSafetyHistoryView> {
    const participant = await this.getOwnedParticipant(participantId, userId, true);

    const [events, notifications] = await Promise.all([
      this.participantEventRepository.find({
        where: { participantId: participant.id },
        order: { occurredAt: 'ASC' },
      }),
      this.participantNotificationRepository.find({
        where: { participantId: participant.id },
        order: { createdAt: 'ASC' },
      }),
    ]);

    return {
      participant: await this.sanitizeParticipant(participant, true),
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        previousStatus: event.previousStatus,
        nextStatus: event.nextStatus,
        metadata: event.metadata,
        occurredAt: event.occurredAt,
      })),
      notifications: notifications.map((notification) => ({
        id: notification.id,
        notificationType: notification.notificationType,
        channel: notification.channel,
        recipient: notification.recipient,
        status: notification.status,
        errorMessage: notification.errorMessage,
        sentAt: notification.sentAt,
        createdAt: notification.createdAt,
      })),
    };
  }

  async getTripParticipants(
    tripId: string,
    userId: string,
  ): Promise<TripSafetyParticipantView[]> {
    await this.verifyTripParticipation(userId, tripId);

    const participants = await this.participantRepository.find({
      where: { tripId },
      relations: ['trustedContacts'],
      order: { createdAt: 'ASC' },
    });

    return Promise.all(
      participants.map((participant) =>
        this.sanitizeParticipant(participant, participant.userId === userId),
      ),
    );
  }

  async getTripHistory(
    tripId: string,
    userId: string,
  ): Promise<{
    tripId: string;
    participants: TripSafetyParticipantView[];
    events: Array<{
      id: string;
      participantId: string;
      userId: string;
      type: TripSafetyEventType;
      previousStatus: TripSafetyStatus | null;
      nextStatus: TripSafetyStatus | null;
      metadata: Record<string, unknown> | null;
      occurredAt: Date;
    }>;
  }> {
    await this.verifyTripParticipation(userId, tripId);

    const participants = await this.getTripParticipants(tripId, userId);
    const events = await this.participantEventRepository.find({
      where: { tripId },
      order: { occurredAt: 'ASC' },
    });

    return {
      tripId,
      participants,
      events: events.map((event) => ({
        id: event.id,
        participantId: event.participantId,
        userId: event.userId,
        type: event.type,
        previousStatus: event.previousStatus,
        nextStatus: event.nextStatus,
        metadata: event.metadata,
        occurredAt: event.occurredAt,
      })),
    };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processAutomaticTripSecurityLifecycle() {
    // Keep request latency stable: the cron body runs in the next tick.
    setImmediate(async () => {
      await this.processAutomaticFollowUps();
    });
  }

  async processAutomaticFollowUps(): Promise<{
    processed: number;
    reminders: number;
    escalations: number;
    autoDetections: number;
  }> {
    const activeStatuses: TripSafetyStatus[] = [
      TripSafetyStatus.PENDING,
      TripSafetyStatus.BOARDED,
      TripSafetyStatus.IN_TRANSIT,
      TripSafetyStatus.ARRIVAL_UNCONFIRMED,
      TripSafetyStatus.DROPOFF_UNCONFIRMED,
      TripSafetyStatus.ALERTED_CONTACTS,
    ];

    const participants = await this.participantRepository.find({
      where: {
        status: In(activeStatuses),
        cancelledAt: IsNull(),
      },
      relations: ['trip', 'booking'],
    });

    if (participants.length === 0) {
      return {
        processed: 0,
        reminders: 0,
        escalations: 0,
        autoDetections: 0,
      };
    }

    const now = new Date();
    let reminders = 0;
    let escalations = 0;
    let autoDetections = 0;

    for (const participant of participants) {
      if (participant.confirmedAt || participant.completedAt) {
        continue;
      }

      let detectedTripEnd = false;
      if (await this.shouldMarkTripAsEnded(participant)) {
        detectedTripEnd = true;
        if (!participant.tripEndedDetectedAt) {
          participant.tripEndedDetectedAt = now;
          await this.participantRepository.save(participant);
          autoDetections += 1;

          await this.logEvent(
            participant,
            TripSafetyEventType.AUTO_TRIP_END_DETECTED,
            participant.status,
            participant.status,
            {
              detectedAt: now.toISOString(),
            },
          );
        }
      }

      const needsReminder =
        !participant.reminderSentAt &&
        this.isMissingConfirmation(participant, now, detectedTripEnd);

      if (needsReminder) {
        await this.sendReminder(participant, detectedTripEnd ? 'trip_end_detected' : 'eta_exceeded');
        reminders += 1;
      }

      const canEscalate =
        participant.reminderSentAt &&
        !participant.isEscalated &&
        !participant.confirmedAt &&
        now.getTime() >=
          participant.reminderSentAt.getTime() + participant.escalationDelayMinutes * 60 * 1000;

      if (canEscalate) {
        await this.triggerEscalation(participant, 'no_confirmation_after_reminder');
        escalations += 1;
      }
    }

    return {
      processed: participants.length,
      reminders,
      escalations,
      autoDetections,
    };
  }

  private async resolveParticipantContext(
    userId: string,
    tripId: string,
    bookingId?: string,
  ): Promise<ParticipantContext> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'firstName', 'lastName', 'fcmToken', 'phone', 'email'],
    });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouvé');
    }

    if (bookingId) {
      const booking = await this.bookingRepository.findOne({
        where: { id: bookingId },
        relations: ['trip'],
      });

      if (!booking) {
        throw new NotFoundException('Réservation non trouvée');
      }

      if (booking.tripId !== tripId) {
        throw new BadRequestException('Le booking ne correspond pas au trajet fourni');
      }

      if (booking.passengerId !== userId) {
        throw new ForbiddenException(
          'Seul le passager concerné peut démarrer son propre suivi sécurité',
        );
      }

      if (
        booking.status !== BookingStatus.ACCEPTED &&
        booking.status !== BookingStatus.COMPLETED
      ) {
        throw new BadRequestException(
          'Le suivi sécurité passager est disponible pour une réservation acceptée ou terminée',
        );
      }

      return {
        trip: booking.trip,
        booking,
        user,
        role: TripSafetyParticipantRole.PASSENGER,
        participantRef: `booking:${booking.id}:user:${userId}`,
      };
    }

    const trip = await this.tripRepository.findOne({
      where: { id: tripId },
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouvé');
    }

    if (trip.driverId !== userId) {
      throw new ForbiddenException(
        'Seul le conducteur du trajet peut démarrer son propre suivi sécurité sans bookingId',
      );
    }

    return {
      trip,
      booking: null,
      user,
      role: TripSafetyParticipantRole.DRIVER,
      participantRef: `driver:${trip.id}:user:${userId}`,
    };
  }

  private async syncTrustedContacts(
    participant: TripSafetyParticipant,
    userId: string,
    trustedContactIds: string[] | undefined,
    channels: TripSafetyChannel[],
    replaceSelection: boolean,
  ): Promise<void> {
    const existing = await this.participantContactRepository.find({
      where: { participantId: participant.id },
    });

    let selectedContacts: EmergencyContact[] = [];
    if (trustedContactIds && trustedContactIds.length > 0) {
      selectedContacts = await this.emergencyContactRepository.find({
        where: {
          userId,
          isActive: true,
          id: In(trustedContactIds),
        },
      });

      if (selectedContacts.length !== trustedContactIds.length) {
        throw new BadRequestException(
          'Certains contacts de confiance sélectionnés sont introuvables ou inactifs',
        );
      }
    } else if (replaceSelection || existing.length === 0) {
      selectedContacts = await this.emergencyContactRepository.find({
        where: {
          userId,
          isActive: true,
        },
        order: { createdAt: 'ASC' },
      });
    } else {
      selectedContacts = await this.emergencyContactRepository.find({
        where: {
          id: In(existing.map((contact) => contact.emergencyContactId)),
          userId,
        },
      });
    }

    if (replaceSelection && existing.length > 0 && trustedContactIds) {
      const idsToKeep = new Set(trustedContactIds);
      const contactsToDelete = existing.filter(
        (existingContact) => !idsToKeep.has(existingContact.emergencyContactId),
      );
      if (contactsToDelete.length > 0) {
        await this.participantContactRepository.delete({
          id: In(contactsToDelete.map((contact) => contact.id)),
        });
      }
    }

    for (const contact of selectedContacts) {
      const match = existing.find(
        (existingContact) => existingContact.emergencyContactId === contact.id,
      );

      if (!match) {
        const participantContact = this.participantContactRepository.create({
          participantId: participant.id,
          emergencyContactId: contact.id,
          contactName: contact.name,
          contactPhone: contact.phone,
          contactEmail: contact.email ?? null,
          channels,
        });
        await this.participantContactRepository.save(participantContact);
        continue;
      }

      match.contactName = contact.name;
      match.contactPhone = contact.phone;
      match.contactEmail = contact.email ?? null;
      match.channels = channels;
      await this.participantContactRepository.save(match);
    }
  }

  private async markBoardedAndInTransit(
    participant: TripSafetyParticipant,
    action: TripSecurityStartAction,
  ): Promise<void> {
    const now = new Date();

    if (participant.status === TripSafetyStatus.PENDING) {
      participant.status = TripSafetyStatus.BOARDED;
      participant.startedAt = participant.startedAt ?? now;
      participant.boardedAt = participant.boardedAt ?? now;
      participant = await this.participantRepository.save(participant);

      await this.logEvent(
        participant,
        TripSafetyEventType.BOARDED,
        TripSafetyStatus.PENDING,
        TripSafetyStatus.BOARDED,
        { action },
      );
    }

    if (participant.status !== TripSafetyStatus.IN_TRANSIT) {
      const previousStatus = participant.status;
      participant.status = TripSafetyStatus.IN_TRANSIT;
      participant.inTransitAt = participant.inTransitAt ?? now;
      participant = await this.participantRepository.save(participant);

      await this.logEvent(
        participant,
        TripSafetyEventType.IN_TRANSIT,
        previousStatus,
        TripSafetyStatus.IN_TRANSIT,
        { action },
      );
    }
  }

  private async sendReminder(
    participant: TripSafetyParticipant,
    reason: 'trip_end_detected' | 'eta_exceeded',
  ): Promise<void> {
    const previousStatus = participant.status;
    const unconfirmedStatus = this.unconfirmedStatusForRole(participant.role);
    participant.status = unconfirmedStatus;
    participant.reminderSentAt = new Date();
    participant.reminderCount += 1;
    participant = await this.participantRepository.save(participant);

    await this.logEvent(
      participant,
      TripSafetyEventType.ESTIMATED_END_REACHED,
      previousStatus,
      participant.status,
      {
        reason,
      },
    );

    await this.sendParticipantPushNotification(
      participant,
      TripSafetyNotificationType.REMINDER,
      'Confirmez votre arrivée',
      "Nous n'avons pas encore reçu votre confirmation de fin de trajet. Merci de confirmer votre arrivée ou votre dépôt.",
      {
        participantId: participant.id,
        status: participant.status,
      },
      `reminder:${participant.id}:${participant.reminderCount}`,
    );

    await this.logEvent(
      participant,
      TripSafetyEventType.REMINDER_SENT,
      participant.status,
      participant.status,
      {
        reminderCount: participant.reminderCount,
      },
    );
  }

  private async triggerEscalation(
    participant: TripSafetyParticipant,
    reason: string,
    channels?: TripSafetyChannel[],
    manualReason?: string,
  ): Promise<NotificationDispatchResult> {
    const resolvedChannels = this.resolveChannels(channels ?? participant.notificationChannels);

    if (participant.isEscalated) {
      return { sent: 0, failed: 0, skipped: 0 };
    }

    const previousStatus = participant.status;
    participant.status = TripSafetyStatus.ALERTED_CONTACTS;
    participant.isEscalated = true;
    participant.escalatedAt = new Date();
    participant = await this.participantRepository.save(participant);

    const notificationStats = await this.notifyTrustedContactsInternal(
      participant,
      TripSafetyNotificationType.ESCALATION,
      {
        channels: resolvedChannels,
        customMessage:
          manualReason ??
          "Aucune confirmation d'arrivée n'a été reçue après le délai de sécurité.",
      },
    );

    await this.ensureNoResponseAlert(participant);

    await this.logEvent(
      participant,
      TripSafetyEventType.ESCALATION_TRIGGERED,
      previousStatus,
      participant.status,
      {
        reason,
        manualReason: manualReason ?? null,
        notificationStats,
      },
    );

    await this.sendParticipantPushNotification(
      participant,
      TripSafetyNotificationType.INCIDENT_SIGNAL,
      'Alerte envoyée à vos proches',
      'Nous avons signalé un incident potentiel à vos proches de confiance car votre arrivée reste non confirmée.',
      {
        participantId: participant.id,
        status: participant.status,
      },
      `escalation-user:${participant.id}`,
    );

    return notificationStats;
  }

  private async ensureNoResponseAlert(participant: TripSafetyParticipant): Promise<void> {
    const whereCondition: any = {
      userId: participant.userId,
      tripId: participant.tripId,
      type: SafetyAlertType.NO_RESPONSE,
      status: SafetyAlertStatus.ACTIVE,
    };

    whereCondition.bookingId = participant.bookingId ? participant.bookingId : IsNull();

    const existingAlert = await this.safetyAlertRepository.findOne({
      where: whereCondition,
    });

    if (existingAlert) {
      return;
    }

    const alert = this.safetyAlertRepository.create({
      userId: participant.userId,
      tripId: participant.tripId,
      bookingId: participant.bookingId,
      type: SafetyAlertType.NO_RESPONSE,
      status: SafetyAlertStatus.ACTIVE,
      message:
        "Aucune confirmation d'arrivée/dépôt reçue après la relance automatique. Incident potentiel à vérifier.",
    });

    await this.safetyAlertRepository.save(alert);
  }

  private async notifyTrustedContactsInternal(
    participant: TripSafetyParticipant,
    notificationType: TripSafetyNotificationType,
    options: {
      channels?: TripSafetyChannel[];
      trustedContactIds?: string[];
      customMessage?: string;
    },
  ): Promise<NotificationDispatchResult> {
    const channels = this.resolveChannels(options.channels ?? participant.notificationChannels);
    const participantContacts = await this.participantContactRepository.find({
      where: { participantId: participant.id },
      order: { createdAt: 'ASC' },
    });

    const selectedContacts =
      options.trustedContactIds && options.trustedContactIds.length > 0
        ? participantContacts.filter((contact) =>
            options.trustedContactIds!.includes(contact.emergencyContactId),
          )
        : participantContacts;

    if (selectedContacts.length === 0) {
      return { sent: 0, failed: 0, skipped: 0 };
    }

    const context = await this.buildMessageContext(participant);
    const baseMessage = this.buildTrustedContactMessage(context, notificationType);
    const messageWithCustomSuffix = options.customMessage
      ? `${baseMessage}\n\nNote: ${options.customMessage}`
      : baseMessage;

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const contact of selectedContacts) {
      const allowedChannels = channels.filter((channel) => contact.channels.includes(channel));
      const channelsToUse = allowedChannels.length > 0 ? allowedChannels : channels;

      for (const channel of channelsToUse) {
        const dedupeKey = `${notificationType}:${participant.id}:${contact.id}:${channel}`;
        const result = await this.sendContactNotification(
          participant,
          contact,
          channel,
          notificationType,
          this.subjectForNotificationType(notificationType),
          messageWithCustomSuffix,
          {
            participantId: participant.id,
            tripId: participant.tripId,
            bookingId: participant.bookingId,
            trackingCode: participant.trackingCode,
            role: participant.role,
            status: participant.status,
          },
          dedupeKey,
        );

        if (result === TripSafetyNotificationStatus.SENT) {
          sent += 1;
        } else if (result === TripSafetyNotificationStatus.FAILED) {
          failed += 1;
        } else {
          skipped += 1;
        }
      }

      contact.lastNotifiedAt = new Date();
      await this.participantContactRepository.save(contact);
    }

    await this.logEvent(
      participant,
      TripSafetyEventType.TRUSTED_CONTACTS_NOTIFIED,
      participant.status,
      participant.status,
      {
        notificationType,
        channels,
        contactsNotified: selectedContacts.length,
        sent,
        failed,
        skipped,
      },
    );

    return { sent, failed, skipped };
  }

  private async sendContactNotification(
    participant: TripSafetyParticipant,
    participantContact: TripSafetyContact,
    channel: TripSafetyChannel,
    notificationType: TripSafetyNotificationType,
    subject: string,
    body: string,
    payload: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<TripSafetyNotificationStatus> {
    const existing = await this.participantNotificationRepository.findOne({
      where: { dedupeKey },
    });

    if (existing && existing.status !== TripSafetyNotificationStatus.FAILED) {
      return TripSafetyNotificationStatus.SKIPPED;
    }

    const notification = this.participantNotificationRepository.create({
      participantId: participant.id,
      tripId: participant.tripId,
      bookingId: participant.bookingId,
      userId: null,
      emergencyContactId: participantContact.emergencyContactId,
      channel,
      notificationType,
      recipient: this.recipientForChannel(participantContact, channel),
      subject,
      body,
      payload,
      dedupeKey,
      status: TripSafetyNotificationStatus.PENDING,
    });

    await this.participantNotificationRepository.save(notification);

    try {
      if (channel === TripSafetyChannel.WHATSAPP) {
        if (!participantContact.contactPhone) {
          notification.status = TripSafetyNotificationStatus.SKIPPED;
          notification.errorMessage = 'Numero de telephone absent';
          await this.participantNotificationRepository.save(notification);
          return notification.status;
        }

        const success = await this.whatsAppService.sendMessage(
          participantContact.contactPhone,
          body,
        );
        if (!success) {
          throw new Error('Echec envoi WhatsApp');
        }

        notification.providerMessageId = `whatsapp_${Date.now()}`;
      } else if (channel === TripSafetyChannel.SMS) {
        if (!participantContact.contactPhone) {
          notification.status = TripSafetyNotificationStatus.SKIPPED;
          notification.errorMessage = 'Numero de telephone absent';
          await this.participantNotificationRepository.save(notification);
          return notification.status;
        }

        notification.providerMessageId = await this.sendSms(
          participantContact.contactPhone,
          body,
        );
      } else if (channel === TripSafetyChannel.EMAIL) {
        if (!participantContact.contactEmail) {
          notification.status = TripSafetyNotificationStatus.SKIPPED;
          notification.errorMessage = 'Adresse email absente';
          await this.participantNotificationRepository.save(notification);
          return notification.status;
        }

        notification.providerMessageId = await this.sendEmail(
          participantContact.contactEmail,
          subject,
          body,
        );
      } else {
        const contactUser = await this.findAppUserByContact(participantContact);
        if (!contactUser?.fcmToken) {
          notification.status = TripSafetyNotificationStatus.SKIPPED;
          notification.errorMessage = 'Aucun token push disponible pour ce contact';
          await this.participantNotificationRepository.save(notification);
          return notification.status;
        }

        await this.notificationService.sendNotification(
          contactUser.fcmToken,
          subject,
          body,
          payload,
          contactUser.id,
        );
        notification.userId = contactUser.id;
      }

      notification.status = TripSafetyNotificationStatus.SENT;
      notification.sentAt = new Date();
      notification.errorMessage = null;
      await this.participantNotificationRepository.save(notification);
      return notification.status;
    } catch (error) {
      notification.status = TripSafetyNotificationStatus.FAILED;
      notification.errorMessage = error.message;
      await this.participantNotificationRepository.save(notification);
      this.logger.error(
        `Erreur notification contact (${channel}) pour participant ${participant.id}: ${error.message}`,
        error.stack,
      );
      return notification.status;
    }
  }

  private async sendParticipantPushNotification(
    participant: TripSafetyParticipant,
    notificationType: TripSafetyNotificationType,
    title: string,
    body: string,
    payload: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<void> {
    const existing = await this.participantNotificationRepository.findOne({
      where: { dedupeKey },
    });
    if (existing && existing.status !== TripSafetyNotificationStatus.FAILED) {
      return;
    }

    const user = await this.userRepository.findOne({
      where: { id: participant.userId },
      select: ['id', 'fcmToken'],
    });

    const notification = this.participantNotificationRepository.create({
      participantId: participant.id,
      tripId: participant.tripId,
      bookingId: participant.bookingId,
      userId: participant.userId,
      emergencyContactId: null,
      channel: TripSafetyChannel.PUSH,
      notificationType,
      recipient: participant.userId,
      subject: title,
      body,
      payload,
      dedupeKey,
      status: TripSafetyNotificationStatus.PENDING,
    });
    await this.participantNotificationRepository.save(notification);

    if (!user?.fcmToken) {
      notification.status = TripSafetyNotificationStatus.SKIPPED;
      notification.errorMessage = 'Utilisateur sans token FCM';
      await this.participantNotificationRepository.save(notification);
      return;
    }

    try {
      await this.notificationService.sendNotification(
        user.fcmToken,
        title,
        body,
        payload,
        participant.userId,
      );
      notification.status = TripSafetyNotificationStatus.SENT;
      notification.sentAt = new Date();
      notification.errorMessage = null;
      await this.participantNotificationRepository.save(notification);
    } catch (error) {
      notification.status = TripSafetyNotificationStatus.FAILED;
      notification.errorMessage = error.message;
      await this.participantNotificationRepository.save(notification);
    }
  }

  private async buildMessageContext(
    participant: TripSafetyParticipant,
  ): Promise<TrackingMessageContext> {
    const trip = await this.tripRepository.findOne({
      where: { id: participant.tripId },
      relations: ['driver', 'vehicle'],
    });
    if (!trip) {
      throw new NotFoundException('Trajet introuvable pour le suivi sécurité');
    }

    const participantUser = await this.userRepository.findOne({
      where: { id: participant.userId },
      select: ['id', 'firstName', 'lastName', 'phone', 'email'],
    });
    if (!participantUser) {
      throw new NotFoundException('Utilisateur participant introuvable');
    }

    const booking =
      participant.bookingId !== null
        ? await this.bookingRepository.findOne({
            where: { id: participant.bookingId },
          })
        : null;

    return {
      participant,
      trip,
      booking,
      participantUser,
      driver: trip.driver ?? null,
    };
  }

  private buildTrustedContactMessage(
    context: TrackingMessageContext,
    notificationType: TripSafetyNotificationType,
  ): string {
    const participantName =
      `${context.participantUser.firstName} ${context.participantUser.lastName}`.trim();
    const roleLabel =
      context.participant.role === TripSafetyParticipantRole.DRIVER ? 'conducteur' : 'passager';
    const destination =
      context.booking?.passengerDestination ||
      context.trip.arrivalLocation ||
      'Destination non renseignée';
    const departure = context.booking?.passengerOrigin || context.trip.departureLocation;
    const departureTime = context.trip.departureDate?.toISOString() ?? 'non renseignée';
    const driverName = context.driver
      ? `${context.driver.firstName} ${context.driver.lastName}`.trim()
      : 'Non renseigné';
    const driverPhone = context.driver?.phone ?? 'Non renseigné';
    const vehicleLabel = context.trip.vehicle
      ? `${context.trip.vehicle.brand} ${context.trip.vehicle.model} (${context.trip.vehicle.licensePlate})`
      : 'Véhicule non renseigné';
    const trackingLink = this.buildTrackingLink(context.participant.trackingCode);
    const currentStatus = this.humanReadableStatus(context.participant.status);

    if (notificationType === TripSafetyNotificationType.CONFIRMATION) {
      return [
        `✅ ${participantName} (${roleLabel}) a confirmé sa fin de trajet.`,
        `Statut final: ${currentStatus}.`,
        `Trajet: ${departure} -> ${destination}.`,
        `Suivi: ${trackingLink}.`,
      ].join('\n');
    }

    if (notificationType === TripSafetyNotificationType.ESCALATION) {
      return [
        `⚠️ Alerte sécurité: ${participantName} (${roleLabel}) n'a pas confirmé sa fin de trajet.`,
        `Trajet: ${departure} -> ${destination}.`,
        `Heure de départ: ${departureTime}.`,
        `Conducteur: ${driverName} (${driverPhone}).`,
        `Véhicule: ${vehicleLabel}.`,
        `Statut courant: ${currentStatus}.`,
        `Lien de suivi: ${trackingLink}.`,
      ].join('\n');
    }

    return [
      `🚗 ${participantName} (${roleLabel}) vient de signaler son embarquement.`,
      `Départ: ${departure}.`,
      `Destination: ${destination}.`,
      `Heure de départ: ${departureTime}.`,
      `Conducteur: ${driverName} (${driverPhone}).`,
      `Véhicule: ${vehicleLabel}.`,
      `Identifiant de suivi: ${context.participant.trackingCode}.`,
      `Lien de suivi: ${trackingLink}.`,
      `Statut courant: ${currentStatus}.`,
    ].join('\n');
  }

  private async logEvent(
    participant: TripSafetyParticipant,
    type: TripSafetyEventType,
    previousStatus: TripSafetyStatus | null,
    nextStatus: TripSafetyStatus | null,
    metadata: Record<string, unknown> | null = null,
  ): Promise<void> {
    const event = this.participantEventRepository.create({
      participantId: participant.id,
      tripId: participant.tripId,
      bookingId: participant.bookingId,
      userId: participant.userId,
      type,
      previousStatus,
      nextStatus,
      metadata,
    });
    await this.participantEventRepository.save(event);
  }

  private async getOwnedParticipant(
    participantId: string,
    userId: string,
    withRelations = false,
  ): Promise<TripSafetyParticipant> {
    const participant = await this.participantRepository.findOne({
      where: { id: participantId },
      relations: withRelations ? ['trustedContacts'] : undefined,
    });

    if (!participant) {
      throw new NotFoundException('Participant de sécurité trajet introuvable');
    }

    if (participant.userId !== userId) {
      throw new ForbiddenException(
        'Vous ne pouvez pas accéder au suivi sécurité d’un autre participant',
      );
    }

    return participant;
  }

  private async verifyTripParticipation(userId: string, tripId: string): Promise<void> {
    const trip = await this.tripRepository.findOne({
      where: { id: tripId },
      relations: ['bookings'],
    });

    if (!trip) {
      throw new NotFoundException('Trajet non trouvé');
    }

    const isDriver = trip.driverId === userId;
    const isPassenger = (trip.bookings ?? []).some(
      (booking) =>
        booking.passengerId === userId &&
        (booking.status === BookingStatus.ACCEPTED || booking.status === BookingStatus.COMPLETED),
    );

    if (!isDriver && !isPassenger) {
      throw new ForbiddenException('Vous ne participez pas à ce trajet');
    }
  }

  private validateConfirmationOutcome(
    participant: TripSafetyParticipant,
    outcome: TripSecurityConfirmationOutcome,
  ) {
    if (
      participant.role === TripSafetyParticipantRole.DRIVER &&
      outcome === TripSecurityConfirmationOutcome.DROPPED_OFF
    ) {
      throw new BadRequestException(
        'Le conducteur doit confirmer son arrivée ou la fin du trajet',
      );
    }

    if (
      participant.role === TripSafetyParticipantRole.PASSENGER &&
      outcome === TripSecurityConfirmationOutcome.TRIP_ENDED
    ) {
      return;
    }
  }

  private async shouldMarkTripAsEnded(participant: TripSafetyParticipant): Promise<boolean> {
    const trip = participant.trip
      ? participant.trip
      : await this.tripRepository.findOne({ where: { id: participant.tripId } });
    if (!trip) {
      return false;
    }

    if (trip.status === TripStatus.COMPLETED || !!trip.completedAt) {
      return true;
    }

    if (participant.role === TripSafetyParticipantRole.PASSENGER && participant.bookingId) {
      const booking = participant.booking
        ? participant.booking
        : await this.bookingRepository.findOne({ where: { id: participant.bookingId } });

      if (!booking) {
        return false;
      }

      return (
        booking.droppedOff ||
        booking.droppedOffConfirmedByPassenger ||
        booking.status === BookingStatus.COMPLETED
      );
    }

    return false;
  }

  private isMissingConfirmation(
    participant: TripSafetyParticipant,
    now: Date,
    tripEndDetected: boolean,
  ): boolean {
    if (this.isUnconfirmedStatus(participant.status)) {
      return false;
    }

    if (tripEndDetected) {
      return true;
    }

    if (!participant.estimatedEndAt) {
      return false;
    }

    const threshold =
      participant.estimatedEndAt.getTime() + participant.reminderDelayMinutes * 60 * 1000;
    return now.getTime() >= threshold;
  }

  private isUnconfirmedStatus(status: TripSafetyStatus): boolean {
    return (
      status === TripSafetyStatus.ARRIVAL_UNCONFIRMED ||
      status === TripSafetyStatus.DROPOFF_UNCONFIRMED ||
      status === TripSafetyStatus.ALERTED_CONTACTS
    );
  }

  private unconfirmedStatusForRole(role: TripSafetyParticipantRole): TripSafetyStatus {
    return role === TripSafetyParticipantRole.DRIVER
      ? TripSafetyStatus.ARRIVAL_UNCONFIRMED
      : TripSafetyStatus.DROPOFF_UNCONFIRMED;
  }

  private async sanitizeParticipant(
    participant: TripSafetyParticipant,
    includeContacts: boolean,
  ): Promise<TripSafetyParticipantView> {
    const trustedContacts = includeContacts
      ? await this.participantContactRepository.find({
          where: { participantId: participant.id },
          order: { createdAt: 'ASC' },
        })
      : [];

    return {
      id: participant.id,
      tripId: participant.tripId,
      bookingId: participant.bookingId,
      userId: participant.userId,
      role: participant.role,
      status: participant.status,
      startedAt: participant.startedAt,
      boardedAt: participant.boardedAt,
      inTransitAt: participant.inTransitAt,
      estimatedEndAt: participant.estimatedEndAt,
      tripEndedDetectedAt: participant.tripEndedDetectedAt,
      droppedOffAt: participant.droppedOffAt,
      arrivedAt: participant.arrivedAt,
      confirmedAt: participant.confirmedAt,
      completedAt: participant.completedAt,
      reminderSentAt: participant.reminderSentAt,
      reminderCount: participant.reminderCount,
      escalatedAt: participant.escalatedAt,
      isEscalated: participant.isEscalated,
      reminderDelayMinutes: participant.reminderDelayMinutes,
      escalationDelayMinutes: participant.escalationDelayMinutes,
      notificationChannels: participant.notificationChannels,
      trackingCode: participant.trackingCode,
      cancelledAt: participant.cancelledAt,
      trustedContacts: trustedContacts.map((contact) => ({
        id: contact.id,
        emergencyContactId: contact.emergencyContactId,
        name: contact.contactName,
        phone: contact.contactPhone,
        email: contact.contactEmail,
        channels: contact.channels,
        lastNotifiedAt: contact.lastNotifiedAt,
      })),
      createdAt: participant.createdAt,
      updatedAt: participant.updatedAt,
    };
  }

  private resolveChannels(channels?: TripSafetyChannel[]): TripSafetyChannel[] {
    const allowedChannels = new Set(Object.values(TripSafetyChannel));
    const requested = channels && channels.length > 0 ? channels : this.defaultChannels();
    const unique = [...new Set(requested)].filter((channel) => allowedChannels.has(channel));

    if (unique.length === 0) {
      throw new BadRequestException('Au moins un canal de notification doit être actif');
    }

    return unique;
  }

  private defaultChannels(): TripSafetyChannel[] {
    const raw = this.configService.get<string>('TRIP_SECURITY_NOTIFICATION_CHANNELS');
    if (!raw) {
      return [TripSafetyChannel.WHATSAPP];
    }

    const parsed = raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean) as TripSafetyChannel[];
    return parsed.length > 0 ? parsed : [TripSafetyChannel.WHATSAPP];
  }

  private defaultReminderDelayMinutes(): number {
    const value = Number(this.configService.get<string>('TRIP_SECURITY_REMINDER_DELAY_MINUTES'));
    return Number.isFinite(value) && value > 0 ? value : 10;
  }

  private defaultEscalationDelayMinutes(): number {
    const value = Number(this.configService.get<string>('TRIP_SECURITY_ESCALATION_DELAY_MINUTES'));
    return Number.isFinite(value) && value > 0 ? value : 15;
  }

  private defaultEstimatedDurationMinutes(): number {
    const value = Number(
      this.configService.get<string>('TRIP_SECURITY_DEFAULT_ESTIMATED_DURATION_MINUTES'),
    );
    return Number.isFinite(value) && value > 0 ? value : 90;
  }

  private computeDefaultEstimatedEnd(trip: Trip): Date {
    const base = trip.departureDate ? new Date(trip.departureDate) : new Date();
    return new Date(base.getTime() + this.defaultEstimatedDurationMinutes() * 60 * 1000);
  }

  private buildTrackingLink(trackingCode: string): string {
    const base =
      this.configService.get<string>('TRIP_SECURITY_TRACKING_BASE_URL') ??
      'https://zwanga.app/trip-security';
    return `${base.replace(/\/+$/, '')}/${trackingCode}`;
  }

  private subjectForNotificationType(type: TripSafetyNotificationType): string {
    if (type === TripSafetyNotificationType.ESCALATION) {
      return 'Alerte sécurité trajet';
    }
    if (type === TripSafetyNotificationType.CONFIRMATION) {
      return 'Confirmation de fin de trajet';
    }
    return 'Mise à jour de sécurité trajet';
  }

  private recipientForChannel(contact: TripSafetyContact, channel: TripSafetyChannel): string {
    if (channel === TripSafetyChannel.WHATSAPP) {
      return contact.contactPhone ?? 'phone_missing';
    }
    if (channel === TripSafetyChannel.EMAIL) {
      return contact.contactEmail ?? 'email_missing';
    }
    if (channel === TripSafetyChannel.SMS) {
      return contact.contactPhone ?? 'phone_missing';
    }
    return `app-contact:${contact.emergencyContactId}`;
  }

  private async sendSms(phone: string, body: string): Promise<string> {
    // Placeholder channel adapter: ready to be replaced by a real SMS provider.
    this.logger.warn(`[TripSecurity][SMS] ${phone} <- ${body}`);
    return `sms_${Date.now()}`;
  }

  private async sendEmail(email: string, subject: string, body: string): Promise<string> {
    // Placeholder channel adapter: ready to be replaced by a real email provider.
    this.logger.warn(`[TripSecurity][EMAIL] ${email} <- ${subject} | ${body}`);
    return `email_${Date.now()}`;
  }

  private async findAppUserByContact(contact: TripSafetyContact): Promise<User | null> {
    const where: Array<Record<string, string>> = [];

    if (contact.contactPhone) {
      where.push({ phone: contact.contactPhone });
    }
    if (contact.contactEmail) {
      where.push({ email: contact.contactEmail });
    }

    if (where.length === 0) {
      return null;
    }

    return this.userRepository.findOne({
      where,
      select: ['id', 'fcmToken'],
    });
  }

  private humanReadableStatus(status: TripSafetyStatus): string {
    const labels: Record<TripSafetyStatus, string> = {
      [TripSafetyStatus.PENDING]: 'En attente',
      [TripSafetyStatus.BOARDED]: 'Embarqué',
      [TripSafetyStatus.IN_TRANSIT]: 'En cours de trajet',
      [TripSafetyStatus.DROPPED_OFF]: 'Déposé',
      [TripSafetyStatus.ARRIVED]: 'Arrivé',
      [TripSafetyStatus.COMPLETED]: 'Terminé',
      [TripSafetyStatus.ARRIVAL_UNCONFIRMED]: 'Arrivée non confirmée',
      [TripSafetyStatus.DROPOFF_UNCONFIRMED]: 'Dépôt non confirmé',
      [TripSafetyStatus.ALERTED_CONTACTS]: 'Signalé aux proches',
    };
    return labels[status];
  }

  private generateTrackingCode(): string {
    const randomPart = Math.random().toString(36).slice(2, 10).toUpperCase();
    return `TS-${Date.now().toString(36).toUpperCase()}-${randomPart}`;
  }
}
