import { isAppUpdateDeliverable } from '../app-updates/app-update-dispatch.service';
import {
  cert,
  initializeApp,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import { createHash } from 'node:crypto';
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import {
  Notification,
  NotificationStatus,
} from './entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { DriverPayout } from '../driver-settlements/entities/driver-payout.entity';
import { WalletWithdrawal } from '../wallet/entities/wallet-withdrawal.entity';
import { ReferralWithdrawal } from '../referrals/entities/referral-withdrawal.entity';
import { KycDocument } from '../users/entities/kyc-document.entity';
import { LATEST_IDENTITY_ORDER } from '../users/profile-state';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { PawaPayRefund } from '../payments/entities/pawapay-refund.entity';
import {
  TripRequest,
  TripRequestStatus,
} from '../trip-requests/entities/trip-request.entity';

const AUTOMATIC_NOTIFICATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_RECEIPTS_API_URL =
  'https://exp.host/--/api/v2/push/getReceipts';
const PUSH_DELIVERY_TIMEOUT_MS = 10_000;
const CRITICAL_RETRY_DELAY_MS = 5 * 60 * 1000;
const CRITICAL_RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;
const CRITICAL_RETRY_BATCH_SIZE = 25;
const URGENT_NOTIFICATION_TYPES = ['new_booking', 'driver_dispatch_offer'];
const EXPO_RECEIPT_DELAY_MS = 15 * 60 * 1000;
const EXPO_RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const EXPO_RECEIPT_BATCH_SIZE = 100;
const EXPO_TICKET_PREFIX = 'expo-ticket:';
const EXPO_RECEIPT_OK_PREFIX = 'expo-receipt-ok:';
const EXPO_RECEIPT_CHECKING = 'EXPO_RECEIPT_CHECKING';
const CRITICAL_NOTIFICATION_TYPES = [
  'driver_trip_revenue',
  'driver_booking_earning_confirmed',
  'trip_request_driver_overdue',
] as const;

/**
 * Suivi courant des trajets et des demandes de trajet: indispensable dans
 * l'application mobile, mais ces notifications noieraient les alertes
 * importantes dans une boite de reception de back-office.
 */
const ROUTINE_TRIP_NOTIFICATION_TYPES = [
  'daily_engagement',
  'destination_proximity',
  'driver_arrived_destination',
  'driver_near_destination',
  'driver_near_pickup',
  'driver_offer',
  'dropoff_confirmed',
  'dropoff_confirmed_automatically',
  'dropoff_confirmed_by_driver',
  'dropoff_requested_by_passenger',
  'offer_accepted',
  'parties_nearby',
  'passenger_boarding_uncertain',
  'passenger_destination_proximity',
  'passenger_near_destination',
  'passenger_no_show',
  'passenger_ready_pickup',
  'pickup_confirmed',
  'pickup_confirmed_automatically',
  'pickup_confirmed_by_driver',
  'pickup_confirmed_by_passenger',
  'private_trip_cancelled',
  'ride_confirmation_required',
  'trip_departure_reminder',
  'trip_expired',
  'trip_expiring_soon',
  'trip_paused',
  'trip_recommendation',
  'trip_request',
  'trip_request_accepted',
  'trip_request_expired',
  'trip_request_expiring',
  'trip_request_reopened',
  'trip_started',
] as const;

export type NotificationScope = 'all' | 'critical';

interface ExpoPushTicket {
  status?: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoPushResponse {
  data?: ExpoPushTicket | ExpoPushTicket[];
  errors?: Array<{ message?: string; code?: string }>;
}

interface ExpoPushReceiptsResponse {
  data?: Record<string, ExpoPushTicket>;
  errors?: Array<{ message?: string; code?: string }>;
}

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private firebaseApp: App;
  private dispatchingTransactionalNotifications = false;
  private dispatchingUrgentNotifications = false;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(TripRequest)
    private readonly tripRequestRepository: Repository<TripRequest>,
  ) {}

  onModuleInit() {
    const projectId = this.configService.get<string>('FCM_PROJECT_ID');
    const privateKeyBase64 = this.configService.get<string>('FCM_PRIVATE_KEY');
    const clientEmail = this.configService.get<string>('FCM_CLIENT_EMAIL');
    const credentialsBase64 = this.configService.get<string>(
      'FCM_CREDENTIALS_BASE64',
    );

    if (credentialsBase64) {
      // Option 1: Utiliser le fichier JSON complet encodé en base64
      try {
        const credentialsJson = Buffer.from(
          credentialsBase64,
          'base64',
        ).toString('utf-8');
        const credentials = JSON.parse(credentialsJson) as ServiceAccount;
        this.firebaseApp = initializeApp({
          credential: cert(credentials),
        });
        this.logger.log('FCM initialized successfully with base64 credentials');
        return;
      } catch (error) {
        this.logger.error('Error parsing FCM credentials from base64:', error);
      }
    }

    // Option 2: Utiliser les credentials individuels (avec privateKey en base64)
    if (projectId && privateKeyBase64 && clientEmail) {
      try {
        // Décoder la clé privée depuis base64
        const privateKey = Buffer.from(privateKeyBase64, 'base64').toString(
          'utf-8',
        );

        this.firebaseApp = initializeApp({
          credential: cert({
            projectId,
            privateKey: privateKey.replace(/\\n/g, '\n'),
            clientEmail,
          }),
        });
        this.logger.log(
          'FCM initialized successfully with individual credentials',
        );
      } catch (error) {
        this.logger.error(
          'Error initializing FCM with individual credentials:',
          error,
        );
      }
    }
  }

  async sendNotification(
    fcmToken: string,
    title: string,
    body: string,
    data?: Record<string, any>,
    userId?: string,
  ): Promise<boolean> {
    return this.sendNotificationInternal(
      fcmToken,
      title,
      body,
      data,
      userId,
      false,
    );
  }

  /**
   * Persists the notification even if no current device token is available.
   * Critical financial notifications can then be delivered after the app
   * registers a fresh token, while remaining visible in the in-app inbox.
   */
  async sendNotificationToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, any>,
  ): Promise<boolean> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'fcmToken'],
    });
    return this.sendNotificationInternal(
      user?.fcmToken?.trim() ?? '',
      title,
      body,
      data,
      userId,
      false,
    );
  }

  async sendAutomaticNotification(
    fcmToken: string,
    title: string,
    body: string,
    data: Record<string, any> | undefined,
    userId: string,
  ): Promise<boolean> {
    if (!userId) {
      this.logger.warn(
        'Automatic notification skipped because userId is missing',
      );
      return false;
    }

    const canSend = await this.canSendAutomaticNotification(userId);
    if (!canSend) {
      this.logger.debug(
        `Automatic notification skipped for user ${userId}: weekly limit reached`,
      );
      return false;
    }

    return this.sendNotificationInternal(
      fcmToken,
      title,
      body,
      data,
      userId,
      true,
    );
  }

  private async canSendAutomaticNotification(userId: string): Promise<boolean> {
    const since = new Date(Date.now() - AUTOMATIC_NOTIFICATION_COOLDOWN_MS);
    const existingNotification = await this.notificationRepository.findOne({
      where: {
        userId,
        isAutomatic: true,
        status: In([NotificationStatus.PENDING, NotificationStatus.SENT]),
        createdAt: MoreThan(since),
      },
      order: { createdAt: 'DESC' },
      select: ['id'],
    });

    return !existingNotification;
  }

  private async sendNotificationInternal(
    fcmToken: string,
    title: string,
    body: string,
    data?: Record<string, any>,
    userId?: string,
    isAutomatic = false,
  ): Promise<boolean> {
    // Créer l'enregistrement de notification en base de données
    const notification = this.notificationRepository.create({
      userId: userId || null,
      fcmToken,
      title,
      body,
      data: data || null,
      isAutomatic,
      status: NotificationStatus.PENDING,
    });

    // Sauvegarder la notification en attente
    const savedNotification =
      await this.notificationRepository.save(notification);

    return this.deliverSavedNotification(savedNotification);
  }

  private async deliverSavedNotification(
    savedNotification: Notification,
  ): Promise<boolean> {
    // A queued token snapshot is not proof that the device still belongs to this account.
    if (savedNotification.userId) {
      const owner = await this.userRepository.findOne({
        where: { id: savedNotification.userId }, select: ['id', 'fcmToken'],
      });
      savedNotification.fcmToken = owner?.fcmToken?.trim() ?? '';
    }
    const pushToken = savedNotification.fcmToken?.trim();
    if (!pushToken) {
      await this.markNotificationFailed(
        savedNotification,
        'Aucun token push actif pour cet utilisateur',
      );
      return false;
    }

    try {
      this.logger.debug(
        `Verifying unambiguous push ownership`,
      );
      if (savedNotification.userId && await this.userRepository.count({ where: { fcmToken: pushToken } }) !== 1) {
        await this.markNotificationFailed(savedNotification, 'PUSH_TOKEN_OWNERSHIP_AMBIGUOUS');
        return false;
      }
      this.logger.debug(
        `Sending notification through ${this.isExpoPushToken(pushToken) ? 'Expo' : 'FCM'} - Title: ${savedNotification.title}`,
      );
      const messageId = this.isExpoPushToken(pushToken)
        ? await this.sendExpoPushNotification(savedNotification, pushToken)
        : await this.sendFirebaseNotification(savedNotification, pushToken);

      // Mettre à jour la notification avec le statut de succès
      savedNotification.status = NotificationStatus.SENT;
      savedNotification.messageId = messageId;
      savedNotification.errorMessage = null;
      await this.notificationRepository.save(savedNotification);

      this.logger.log(
        `Notification sent successfully - Title: ${savedNotification.title}, MessageId: ${messageId}`,
      );
      return true;
    } catch (error) {
      const message = this.getErrorMessage(error);
      await this.markNotificationFailed(savedNotification, message);
      if (this.isInvalidPushTokenError(error)) {
        await this.clearInvalidPushToken(savedNotification.userId, pushToken);
      }
      this.logger.error(
        `Error sending notification: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }

  private async sendFirebaseNotification(
    notification: Notification,
    pushToken: string,
  ): Promise<string> {
    if (!this.firebaseApp) {
      throw new Error('FCM non configuré sur le serveur');
    }
    const version = await this.driverActionVersion(notification, pushToken);
    if (version > 0) {
      const ringUntil = version === 2 ? this.driverRingUntil(notification) : undefined;
      // No title/message fields: Expo must treat this as headless and let Notifee display it once.
      const data = { ...notification.data, actionProtocol: 'driver-v1', invitationText: notification.body,
        ...(ringUntil ? { ringVersion: 'v2', ringUntil } : {}) };
      return getMessaging(this.firebaseApp).send({ token: pushToken,
        data: this.stringifyNotificationData(data),
        android: { priority: 'high', ttl: this.driverNotificationTtl(notification, ringUntil) * 1000 },
      });
    }
    const passengerRing = notification.data?.type === 'trip_request_accepted' &&
      await this.ringClientVersion(notification, pushToken) === 2;
    return getMessaging(this.firebaseApp).send({
      token: pushToken,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: this.stringifyNotificationData(passengerRing
        ? { ...notification.data, ringAlert: 'request-accepted-v1' } : notification.data),
      ...(passengerRing ? { android: { priority: 'high' as const, ttl: 60_000,
        notification: { channelId: 'booking-ring-v2', sound: 'driver_ring',
          tag: `request-accepted-${notification.data?.tripRequestId}`, visibility: 'private' as const } } } : {}),
    });
  }

  private async sendExpoPushNotification(
    notification: Notification,
    pushToken: string,
  ): Promise<string> {
    const version = await this.driverActionVersion(notification, pushToken);
    const driverActions = version > 0;
    const passengerRing = notification.data?.type === 'trip_request_accepted' &&
      await this.ringClientVersion(notification, pushToken) === 2;
    // APNs can request a bundled sound independently of interactive JS support.
    // An older iOS binary without the file falls back to the system sound. Keep
    // categories and time-sensitive entitlement usage gated by client capability.
    const driverRing = this.isDriverRingInvitation(notification);
    const longRing = driverRing || passengerRing;
    const timeSensitive = version === 2 || passengerRing;
    const ringUntil = driverRing ? this.driverRingUntil(notification) : undefined;
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: pushToken,
        title: notification.title,
        body: notification.body,
        data: driverActions ? { ...notification.data, actionProtocol: 'driver-v1',
          ...(version === 2 ? { ringVersion: 'v2', ringUntil } : {}) }
          : passengerRing ? { ...notification.data, ringAlert: 'request-accepted-v1' } : notification.data ?? undefined,
        ...(driverActions ? { categoryId: version === 2 ? 'driver-offer-v2' : 'driver-offer-v1' } : {}),
        ...(driverRing ? { ttl: this.driverNotificationTtl(notification, ringUntil) } : {}),
        ...(timeSensitive ? { interruptionLevel: 'time-sensitive' } : {}),
        ...(passengerRing ? { channelId: 'booking-ring-v2', ttl: 60 } : {}),
        sound: longRing ? 'driver_ring.wav' : 'default',
        priority: notification.data?.type === 'app_update' ? 'normal' : 'high',
      }),
      signal: AbortSignal.timeout(PUSH_DELIVERY_TIMEOUT_MS),
    });
    const payload = (await response.json()) as ExpoPushResponse;
    if (!response.ok) {
      throw new Error(
        payload.errors?.[0]?.message ||
          `Expo Push a retourne HTTP ${response.status}`,
      );
    }

    const ticket = Array.isArray(payload.data) ? payload.data[0] : payload.data;
    if (!ticket || ticket.status !== 'ok') {
      const error = new Error(
        ticket?.message ||
          payload.errors?.[0]?.message ||
          'Expo Push a refusé la notification',
      ) as Error & { code?: string };
      error.code = `expo/${ticket?.details?.error || payload.errors?.[0]?.code || 'unknown'}`;
      throw error;
    }
    return ticket.id
      ? `${EXPO_TICKET_PREFIX}${ticket.id}`
      : `${EXPO_RECEIPT_OK_PREFIX}accepted-${notification.id}`;
  }

  /** A stale booking stays actionable in-app, but must not ring an hour later. */
  private driverRingUntil(notification: Notification): string {
    const expiry = Date.parse(String(notification.data?.expiresAt ?? ''));
    const deadline = Date.now() + 30_000;
    return new Date(Number.isFinite(expiry) ? Math.min(expiry, deadline) : deadline).toISOString();
  }

  private driverNotificationTtl(notification: Notification, ringUntil?: string): number {
    const deadline = Date.parse(ringUntil ?? String(notification.data?.expiresAt ?? ''));
    return Number.isFinite(deadline) ? Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) : 3600;
  }

  private async driverActionVersion(notification: Notification, pushToken: string): Promise<number> {
    if (!this.isDriverRingInvitation(notification)) return 0;
    return this.ringClientVersion(notification, pushToken);
  }

  private isDriverRingInvitation(notification: Notification): boolean {
    return notification.data?.type === 'new_booking' ||
      (notification.data?.type === 'driver_dispatch_offer' &&
        this.configService.get<string>('DRIVER_DISPATCH_ENABLED') === 'true');
  }

  private async ringClientVersion(notification: Notification, pushToken: string): Promise<number> {
    if (!notification.userId) return 0;
    const rows: { version: number }[] = await this.notificationRepository.manager.query(
      `SELECT CASE WHEN "tokenHash" = $3 THEN 2 ELSE 1 END AS version FROM driver_notification_clients
        WHERE "userId" = $1 AND "tokenHash" IN ($2,$3)`,
      [notification.userId, createHash('sha256').update(pushToken).digest('hex'),
        createHash('sha256').update(pushToken + ':driver-v2').digest('hex')]);
    return rows.length > 0 ? (rows[0].version === 2 ? 2 : 1) : 0;
  }

  private stringifyNotificationData(
    data: Record<string, any> | null,
  ): Record<string, string> | undefined {
    return data
      ? Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, String(value)]),
        )
      : undefined;
  }

  private isExpoPushToken(pushToken: string): boolean {
    return /^(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(pushToken);
  }

  private isInvalidPushTokenError(error: unknown): boolean {
    const rawCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    const code = typeof rawCode === 'string' ? rawCode : '';
    return [
      'messaging/invalid-registration-token',
      'messaging/registration-token-not-registered',
      'expo/DeviceNotRegistered',
    ].includes(code);
  }

  private async clearInvalidPushToken(
    userId: string | null,
    invalidToken: string,
  ): Promise<void> {
    if (!userId) {
      return;
    }
    const result = await this.userRepository.update(
      { id: userId, fcmToken: invalidToken },
      { fcmToken: null },
    );
    if (result.affected) {
      this.logger.warn(
        `Invalid push token cleared for user ${userId}; the app must register a fresh token`,
      );
    }
  }

  private async markNotificationFailed(
    notification: Notification,
    message: string,
  ): Promise<void> {
    notification.status = NotificationStatus.FAILED;
    notification.messageId = null;
    notification.errorMessage = message;
    await this.notificationRepository.save(notification);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** Deliver newly committed outbox rows without holding business/database locks over HTTP. */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async dispatchTransactionalNotifications(): Promise<void> {
    await Promise.all([this.dispatchNotificationLane(false), this.dispatchNotificationLane(true)]);
  }

  @Cron('*/5 * * * * *')
  async dispatchUrgentNotifications(): Promise<void> {
    await this.dispatchNotificationLane(true);
  }

  private async dispatchNotificationLane(urgent: boolean): Promise<void> {
    if (urgent) {
      if (this.dispatchingUrgentNotifications) return;
      this.dispatchingUrgentNotifications = true;
    } else {
      if (this.dispatchingTransactionalNotifications) return;
      this.dispatchingTransactionalNotifications = true;
    }
    try {
      const notifications =
        await this.notificationRepository.manager.transaction(
          async (manager) => {
            const repository = manager.getRepository(Notification);
            const rows = await repository
              .createQueryBuilder('notification')
              .where('notification.eventKey IS NOT NULL')
              .andWhere(urgent
                ? "notification.data ->> 'type' IN (:...urgentTypes)"
                : "COALESCE(notification.data ->> 'type', '') NOT IN (:...urgentTypes)",
                { urgentTypes: URGENT_NOTIFICATION_TYPES })
              .andWhere(urgent
                ? '(notification.status = :pending AND notification.errorMessage IS NULL OR notification.status = :failed AND notification.updatedAt < :retryBefore OR notification.status = :pending AND notification.updatedAt < :leaseBefore)'
                : 'notification.status = :pending AND notification.errorMessage IS NULL', {
                pending: NotificationStatus.PENDING,
                failed: NotificationStatus.FAILED,
                retryBefore: new Date(Date.now() - 15_000),
                leaseBefore: new Date(Date.now() - 120_000),
              })
              .andWhere('notification.isActive = true')
              .orderBy(urgent ? "CASE WHEN notification.data ->> 'type' = 'driver_dispatch_offer' THEN 0 ELSE 1 END" : 'notification.createdAt', 'ASC')
              .addOrderBy('notification.createdAt', 'ASC')
              .addOrderBy('notification.id', 'ASC')
              .take(urgent ? 10 : CRITICAL_RETRY_BATCH_SIZE)
              .setLock('pessimistic_write')
              .setOnLocked('skip_locked')
              .getMany();
            for (const row of rows) {
              row.status = NotificationStatus.PENDING;
              row.errorMessage = 'TRANSACTIONAL_PUSH_CLAIMED';
            }
            return rows.length ? repository.save(rows) : rows;
          },
        );
      // At most five simultaneous requests, all outside the claim transaction.
      for (let index = 0; index < notifications.length; index += 5) {
        await Promise.all(
          notifications.slice(index, index + 5).map(async (notification) => {
            try {
              if (
                !(await this.isCriticalNotificationStillDeliverable(
                  notification,
                ))
              ) {
                await this.suppressCriticalNotification(
                  notification,
                  'Notification transactionnelle remplacée par un état plus récent',
                );
                return;
              }
              await this.deliverSavedNotification(notification);
            } catch (error) {
              // A crashed/failed delivery is recovered by the existing stale-claim retry.
              this.logger.error(
                `TRANSACTIONAL_PUSH_FAILED notificationId=${notification.id}: ${this.getErrorMessage(error)}`,
              );
            }
          }),
        );
      }
    } finally {
      if (urgent) this.dispatchingUrgentNotifications = false;
      else this.dispatchingTransactionalNotifications = false;
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryCriticalFinancialNotifications(): Promise<void> {
    const notifications = await this.claimCriticalFinancialNotifications();
    if (notifications.length === 0) {
      return;
    }

    let delivered = 0;
    for (const notification of notifications) {
      if (!(await this.isCriticalNotificationStillDeliverable(notification))) {
        await this.suppressCriticalNotification(
          notification,
          notification.eventKey
            ? 'Notification transactionnelle remplacée par un état plus récent'
            : 'Notification critique obsolete: demande de trajet non recuperable',
        );
        continue;
      }

      if (!notification.userId) {
        await this.markNotificationFailed(
          notification,
          'Notification financiere sans utilisateur destinataire',
        );
        continue;
      }
      if (await this.deliverSavedNotification(notification)) {
        delivered += 1;
      }
    }

    this.logger.log(
      `CRITICAL_PUSH_RETRY processed=${notifications.length} delivered=${delivered} failed=${notifications.length - delivered}`,
    );
  }

  private async claimCriticalFinancialNotifications(): Promise<Notification[]> {
    const retryBefore = new Date(Date.now() - CRITICAL_RETRY_DELAY_MS);
    const createdAfter = new Date(Date.now() - CRITICAL_RETRY_WINDOW_MS);

    return this.notificationRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(Notification);
      const notifications = await repository
        .createQueryBuilder('notification')
        .where('notification.status IN (:...statuses)', {
          statuses: [NotificationStatus.FAILED, NotificationStatus.PENDING],
        })
        .andWhere(
          "(notification.eventKey IS NOT NULL OR notification.data ->> 'type' IN (:...types))",
          {
            types: [...CRITICAL_NOTIFICATION_TYPES],
          },
        )
        .andWhere('notification.isActive = true')
        .andWhere("COALESCE(notification.data ->> 'type', '') NOT IN (:...urgentTypes)", { urgentTypes: URGENT_NOTIFICATION_TYPES })
        .andWhere('notification.updatedAt <= :retryBefore', { retryBefore })
        .andWhere('notification.createdAt >= :createdAfter', { createdAfter })
        .orderBy('notification.updatedAt', 'ASC')
        .take(CRITICAL_RETRY_BATCH_SIZE)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      for (const notification of notifications) {
        notification.status = NotificationStatus.PENDING;
        // Force an UPDATE even for a stale PENDING row. Once the transaction
        // commits, updatedAt prevents another ECS task from claiming it again.
        notification.errorMessage = 'CRITICAL_PUSH_RETRY_CLAIMED';
      }
      return notifications.length > 0
        ? repository.save(notifications)
        : notifications;
    });
  }

  private async isCriticalNotificationStillDeliverable(
    notification: Notification,
  ): Promise<boolean> {
    const type = notification.data?.type;
    if (type === 'new_booking') {
      const rows: unknown[] = await this.notificationRepository.manager.query(`SELECT 1 FROM bookings b
        JOIN trips t ON t.id = b."tripId" WHERE b.id = $1 AND t."driverId" = $2
        AND b.status = 'pending' AND t.status IN ('upcoming', 'ongoing')
        AND t."tripRequestId" IS NULL`, [notification.data?.bookingId, notification.userId]);
      return rows.length > 0;
    }
    if (type === 'app_update') {
      if (this.configService.get<string>('APP_UPDATES_ENABLED') !== 'true') return false;
      return isAppUpdateDeliverable(this.notificationRepository.manager, notification.data?.releaseId, notification.userId);
    }
    if (type === 'driver_dispatch_offer') {
      if (this.configService.get<string>('DRIVER_DISPATCH_ENABLED') !== 'true') return false;
      const rows: unknown[] = await this.notificationRepository.manager.query(`SELECT 1 FROM trip_request_dispatch_offers o
        JOIN trip_requests r ON r.id = o."requestId" WHERE o.id = $1 AND o."driverId" = $2
        AND o.status = 'pending' AND o."expiresAt" > now() AND r.status = 'pending'`,
        [notification.data?.offerId, notification.userId]);
      return rows.length > 0;
    }
    if (
      notification.eventKey &&
      (type === 'kyc_approved' || type === 'kyc_rejected')
    ) {
      if (!notification.userId) return false;
      const document = await this.notificationRepository.manager.findOne(
        KycDocument,
        { where: { userId: notification.userId }, order: LATEST_IDENTITY_ORDER },
      );
      return Boolean(
        document &&
        document.id === notification.data!.kycId &&
        document.userId === notification.userId &&
        document.status === notification.data!.status &&
        (type === 'kyc_approved' || document.reviewedBy) &&
        (!notification.data!.reviewedAt ||
          document.reviewedAt?.toISOString() === notification.data!.reviewedAt),
      );
    }
    if (
      notification.eventKey &&
      typeof type === 'string' &&
      /^(driver|wallet|referral)_withdrawal_(pending|succeeded|failed|cancelled|review)$/.test(
        type,
      )
    ) {
      const entity = type.startsWith('driver_')
        ? DriverPayout
        : type.startsWith('wallet_')
          ? WalletWithdrawal
          : ReferralWithdrawal;
      const withdrawal = await this.notificationRepository.manager.findOneBy(
        entity as typeof WalletWithdrawal,
        { id: notification.data!.withdrawalId },
      );
      if (!withdrawal) return false;
      const driverPayout = withdrawal as unknown as DriverPayout;
      const review =
        withdrawal.status === 'review' || Boolean(driverPayout.recoveryBlocked);
      const currentStatus = review
        ? 'review'
        : withdrawal.status === 'initiated'
          ? 'pending'
          : withdrawal.status;
      return (
        (driverPayout.driverId ?? withdrawal.userId) === notification.userId &&
        currentStatus === notification.data!.status
      );
    }
    if (
      notification.eventKey &&
      typeof type === 'string' &&
      /^payment_(succeeded|failed|cancelled)$/.test(type)
    ) {
      const payment = await this.notificationRepository.manager.findOneBy(
        PaymentTransaction,
        { id: notification.data!.paymentTransactionId },
      );
      return Boolean(
        payment &&
        payment.userId === notification.userId &&
        payment.status === notification.data!.status,
      );
    }
    if (
      notification.eventKey &&
      typeof type === 'string' &&
      /^payment_refund_(completed|failed)$/.test(type)
    ) {
      const refund = await this.notificationRepository.manager.findOneBy(
        PawaPayRefund,
        { id: notification.data!.refundId },
      );
      return refund?.status === notification.data!.status;
    }
    if (type !== 'trip_request_driver_overdue') {
      return true;
    }

    const tripRequestId = this.extractTripRequestId(notification.data);
    if (!tripRequestId || !notification.userId) {
      return false;
    }

    const request = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
      select: [
        'id',
        'passengerId',
        'status',
        'selectedDriverId',
        'driverPickupOverdueNotifiedAt',
        'departureDateMax',
      ],
    });

    if (!request || request.passengerId !== notification.userId) {
      return false;
    }

    const latestPickupAt = new Date(request.departureDateMax).getTime();
    return (
      request.status === TripRequestStatus.DRIVER_SELECTED &&
      Boolean(request.selectedDriverId) &&
      Boolean(request.driverPickupOverdueNotifiedAt) &&
      Number.isFinite(latestPickupAt) &&
      latestPickupAt <= Date.now()
    );
  }

  private extractTripRequestId(
    data: Record<string, any> | null,
  ): string | null {
    const value = data?.tripRequestId ?? data?.requestId;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private async suppressCriticalNotification(
    notification: Notification,
    reason: string,
  ): Promise<void> {
    notification.status = NotificationStatus.FAILED;
    notification.isActive = false;
    notification.messageId = null;
    notification.errorMessage = reason;
    await this.notificationRepository.save(notification);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileExpoPushReceipts(): Promise<void> {
    const notifications = await this.claimExpoPushReceipts();
    if (notifications.length === 0) {
      return;
    }

    const notificationByReceiptId = new Map<string, Notification>();
    for (const notification of notifications) {
      const receiptId = notification.messageId?.slice(
        EXPO_TICKET_PREFIX.length,
      );
      if (receiptId) {
        notificationByReceiptId.set(receiptId, notification);
      }
    }

    try {
      const response = await fetch(EXPO_PUSH_RECEIPTS_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: [...notificationByReceiptId.keys()] }),
        signal: AbortSignal.timeout(PUSH_DELIVERY_TIMEOUT_MS),
      });
      const payload = (await response.json()) as ExpoPushReceiptsResponse;
      if (!response.ok) {
        throw new Error(
          payload.errors?.[0]?.message ||
            `Expo Push receipts a retourne HTTP ${response.status}`,
        );
      }

      let confirmed = 0;
      let failed = 0;
      for (const [receiptId, notification] of notificationByReceiptId) {
        const receipt = payload.data?.[receiptId];
        if (!receipt) {
          notification.errorMessage = null;
          await this.notificationRepository.save(notification);
          continue;
        }
        if (receipt.status === 'ok') {
          notification.messageId = `${EXPO_RECEIPT_OK_PREFIX}${receiptId}`;
          notification.errorMessage = null;
          await this.notificationRepository.save(notification);
          confirmed += 1;
          continue;
        }

        const error = new Error(
          receipt.message || 'Expo Push receipt a signalé un échec',
        ) as Error & { code?: string };
        error.code = `expo/${receipt.details?.error || 'unknown'}`;
        await this.markNotificationFailed(notification, error.message);
        if (this.isInvalidPushTokenError(error)) {
          await this.clearInvalidPushToken(
            notification.userId,
            notification.fcmToken,
          );
        }
        failed += 1;
      }

      this.logger.log(
        `EXPO_PUSH_RECEIPTS checked=${notifications.length} confirmed=${confirmed} failed=${failed} unavailable=${notifications.length - confirmed - failed}`,
      );
    } catch (error) {
      for (const notification of notifications) {
        notification.errorMessage = null;
      }
      await this.notificationRepository.save(notifications);
      this.logger.error(
        `EXPO_PUSH_RECEIPTS_FAILED count=${notifications.length} reason=${this.getErrorMessage(error)}`,
      );
    }
  }

  private async claimExpoPushReceipts(): Promise<Notification[]> {
    const receiptBefore = new Date(Date.now() - EXPO_RECEIPT_DELAY_MS);
    const createdAfter = new Date(Date.now() - EXPO_RECEIPT_WINDOW_MS);

    return this.notificationRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(Notification);
      const notifications = await repository
        .createQueryBuilder('notification')
        .where('notification.status = :status', {
          status: NotificationStatus.SENT,
        })
        .andWhere('notification.messageId LIKE :ticketPrefix', {
          ticketPrefix: `${EXPO_TICKET_PREFIX}%`,
        })
        .andWhere(
          "(notification.eventKey IS NOT NULL OR notification.data ->> 'type' IN (:...types))",
          {
            types: [...CRITICAL_NOTIFICATION_TYPES],
          },
        )
        .andWhere('notification.isActive = true')
        .andWhere(
          '(notification.errorMessage IS NULL OR notification.errorMessage = :checking)',
          { checking: EXPO_RECEIPT_CHECKING },
        )
        .andWhere('notification.updatedAt <= :receiptBefore', {
          receiptBefore,
        })
        .andWhere('notification.createdAt >= :createdAfter', { createdAfter })
        .orderBy('notification.updatedAt', 'ASC')
        .take(EXPO_RECEIPT_BATCH_SIZE)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      for (const notification of notifications) {
        notification.errorMessage = EXPO_RECEIPT_CHECKING;
      }
      return notifications.length > 0
        ? repository.save(notifications)
        : notifications;
    });
  }

  async sendToMultiple(
    fcmTokens: string[],
    title: string,
    body: string,
    data?: Record<string, any>,
    userIds?: string[],
  ): Promise<void> {
    if ((!this.firebaseApp && !userIds?.length) || fcmTokens.length === 0) {
      this.logger.debug(
        'FCM not configured or no tokens provided, skipping multicast notification',
      );
      return;
    }

    // Créer les enregistrements de notifications en base de données
    const notifications = fcmTokens.map((token, index) =>
      this.notificationRepository.create({
        userId: userIds && userIds[index] ? userIds[index] : null,
        fcmToken: token,
        title,
        body,
        data: data || null,
        isAutomatic: false,
        status: NotificationStatus.PENDING,
      }),
    );

    // Sauvegarder toutes les notifications en attente
    const savedNotifications =
      await this.notificationRepository.save(notifications);

    if (userIds?.length) {
      // Account-addressed batches use current ownership and the appropriate Expo/FCM transport.
      // Never fall back to a stale token when an account id is missing in a partial batch.
      for (let offset = 0; offset < savedNotifications.length; offset += 5) {
        await Promise.all(savedNotifications.slice(offset, offset + 5).map(async notification => {
          try {
            if (!notification.userId) {
              await this.markNotificationFailed(notification, 'Destinataire manquant');
              return;
            }
            await this.deliverSavedNotification(notification);
          } catch { await this.markNotificationFailed(notification, 'Envoi temporairement indisponible'); }
        }));
      }
      return;
    }

    try {
      this.logger.log(
        `Sending multicast notification to ${fcmTokens.length} tokens - Title: ${title}`,
      );

      const message: MulticastMessage = {
        notification: {
          title,
          body,
        },
        data: data
          ? Object.fromEntries(
              Object.entries(data).map(([k, v]) => [k, String(v)]),
            )
          : undefined,
        tokens: fcmTokens,
      };

      const response = await getMessaging(
        this.firebaseApp,
      ).sendEachForMulticast(message);

      // Mettre à jour les notifications selon les résultats
      if (response.responses) {
        for (let i = 0; i < response.responses.length; i++) {
          const notificationResponse = response.responses[i];
          const notification = savedNotifications[i];

          if (notificationResponse.success) {
            notification.status = NotificationStatus.SENT;
            notification.messageId = notificationResponse.messageId || null;
          } else {
            notification.status = NotificationStatus.FAILED;
            notification.errorMessage =
              notificationResponse.error?.message || 'Unknown error';
          }

          await this.notificationRepository.save(notification);
        }
      }

      this.logger.log(
        `Multicast notification sent - Success: ${response.successCount}, Failed: ${response.failureCount}`,
      );
    } catch (error) {
      const message = this.getErrorMessage(error);
      // Marquer toutes les notifications comme échouées en cas d'erreur globale
      for (const notification of savedNotifications) {
        notification.status = NotificationStatus.FAILED;
        notification.errorMessage = message;
        await this.notificationRepository.save(notification);
      }

      this.logger.error(
        `Error sending multicast notifications: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  // ==================== Notification Retrieval ====================

  async findAllByUser(
    userId: string,
    options?: { limit?: number; offset?: number; scope?: NotificationScope },
  ): Promise<{
    notifications: Notification[];
    total: number;
    unreadCount: number;
  }> {
    const scope: NotificationScope = options?.scope ?? 'all';
    this.logger.debug(
      `Fetching notifications for user ${userId} (scope=${scope})`,
    );

    const [notifications, total] = await this.buildInboxQuery(userId, scope)
      .orderBy('notification.createdAt', 'DESC')
      .take(options?.limit)
      .skip(options?.offset)
      .getManyAndCount();

    const unreadCount = await this.buildInboxQuery(userId, scope)
      .andWhere('notification.isRead = false')
      .getCount();

    return {
      notifications,
      total,
      unreadCount,
    };
  }

  /**
   * Boite de reception d'un utilisateur, limitee aux notifications actives.
   * Le scope `critical` retire le suivi courant des trajets, des demandes de
   * trajet et des conversations pour ne garder que ce qui demande une action.
   */
  private buildInboxQuery(userId: string, scope: NotificationScope) {
    const query = this.notificationRepository
      .createQueryBuilder('notification')
      .where('notification.userId = :userId', { userId })
      .andWhere('notification.isActive = true');

    if (scope === 'critical') {
      query
        .andWhere(
          "COALESCE(notification.data ->> 'type', '') NOT IN (:...routineTypes)",
          { routineTypes: [...ROUTINE_TRIP_NOTIFICATION_TYPES] },
        )
        .andWhere("notification.data ->> 'conversationId' IS NULL");
    }

    return query;
  }

  async markAsRead(
    userId: string,
    notificationIds: string[],
  ): Promise<{ updated: number }> {
    this.logger.debug(
      `Marking ${notificationIds.length} notifications as read for user ${userId}`,
    );

    const updateResult = await this.notificationRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: true, readAt: new Date() })
      .where('id IN (:...ids)', { ids: notificationIds })
      .andWhere('userId = :userId', { userId })
      .andWhere('isRead = :isRead', { isRead: false })
      .execute();

    return { updated: updateResult.affected || 0 };
  }

  async markAllAsRead(userId: string): Promise<{ updated: number }> {
    this.logger.debug(
      `Marking all active notifications as read for user ${userId}`,
    );

    const result = await this.notificationRepository.update(
      {
        userId,
        isRead: false,
        isActive: true, // Ne marquer que les notifications actives
      },
      {
        isRead: true,
        readAt: new Date(),
      },
    );

    return { updated: result.affected || 0 };
  }

  async markAsUnread(
    userId: string,
    notificationIds: string[],
  ): Promise<{ updated: number }> {
    this.logger.debug(
      `Marking ${notificationIds.length} notifications as unread for user ${userId}`,
    );

    if (notificationIds.length === 1) {
      const result = await this.notificationRepository.update(
        {
          id: notificationIds[0],
          userId,
        },
        {
          isRead: false,
          readAt: null,
        },
      );
      return { updated: result.affected || 0 };
    }

    const updateResult = await this.notificationRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: false, readAt: null })
      .where('id IN (:...ids)', { ids: notificationIds })
      .andWhere('userId = :userId', { userId })
      .execute();

    return { updated: updateResult.affected || 0 };
  }

  async disableNotifications(
    userId: string,
    notificationIds: string[],
  ): Promise<{ updated: number }> {
    this.logger.debug(
      `Disabling ${notificationIds.length} notifications for user ${userId}`,
    );

    const updateResult = await this.notificationRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ isActive: false })
      .where('id IN (:...ids)', { ids: notificationIds })
      .andWhere('userId = :userId', { userId })
      .andWhere('isActive = :isActive', { isActive: true })
      .execute();

    return { updated: updateResult.affected || 0 };
  }

  async enableNotifications(
    userId: string,
    notificationIds: string[],
  ): Promise<{ updated: number }> {
    this.logger.debug(
      `Enabling ${notificationIds.length} notifications for user ${userId}`,
    );

    const updateResult = await this.notificationRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ isActive: true })
      .where('id IN (:...ids)', { ids: notificationIds })
      .andWhere('userId = :userId', { userId })
      .andWhere('isActive = :isActive', { isActive: false })
      .execute();

    return { updated: updateResult.affected || 0 };
  }
}
