import { sendBoundedFirebase } from './bounded-firebase-send';
import { recoverUnacknowledgedRides } from './recover-unacknowledged-ride';
import { nativeAndroidDriverPush } from './native-android-driver-push';
import { PUSH_CLAIM_LEASE_MS, ownPushClaim, heartbeatPushClaim, renewPushClaim, saveNotificationResult } from './notification-push-claim';
import { isAppUpdateDeliverable } from '../app-updates/app-update-dispatch.service';
import { installationUpdateToken } from '../app-updates/installation-update.policy';
import { isRideResponseDeliverable } from './ride-response-delivery';
import { androidDriverBackup, androidDriverBackupTtl } from './android-driver-backup';
import { isNearbyRingingRequest, prepareNearbyRequestRinging, reconcileNearbyRequestCooldowns } from './nearby-request-cooldown';
import { isTripReminderDeliverable } from './trip-reminder-delivery';
import { isStaleLocationReminderDeliverable } from '../trip-requests/dispatch/stale-location-reminder';
import {
  cert,
  initializeApp,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import { createHash, randomUUID } from 'node:crypto';
import { Injectable, OnModuleInit, Logger, Optional } from '@nestjs/common';
import { RideAlertRealtime } from './ride-alert-realtime.service';
import { claimRideRealtimeNotifications } from './ride-realtime-delivery';
import { iosDriverPush } from './ios-driver-push';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import {
  Notification,
  NotificationStatus,
} from './entities/notification.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { canReceiveDriverRequests, DRIVER_REQUEST_NOTIFICATION_TYPES, isDriverRequestNotification } from './driver-request-policy';
import { resolveDriverRequestOwner } from './driver-request-owner';
import { sharedTripAlertIsDeliverable } from '../trip-requests/dispatch/shared-trip-alert';
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
const URGENT_NOTIFICATION_TYPES = ['new_booking', 'driver_dispatch_offer', 'trip_request_nearby', 'booking_response', 'trip_request_accepted'];
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
  'trip_request_nearby',
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
  private urgentWorkers = 0;
  private dispatchingRealtime = false;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(TripRequest)
    private readonly tripRequestRepository: Repository<TripRequest>,
    @Optional() private readonly rideAlerts?: RideAlertRealtime,
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
          projectId: (credentials as ServiceAccount & { project_id?: string }).projectId ?? (credentials as { project_id?: string }).project_id ?? projectId,
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
          projectId,
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

    return this.notificationRepository.manager.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`zwanga:automatic-push:${userId}`]);
      const notifications = manager.getRepository(Notification);
      if (!await this.canSendAutomaticNotification(userId, notifications)) return false;
      // Enqueue while holding the per-user lock; the existing outbox delivers after commit.
      await notifications.save(notifications.create({
        userId, fcmToken, title, body, data: data ?? null, isAutomatic: true,
        status: NotificationStatus.PENDING, eventKey: `automatic:${userId}:${randomUUID()}`,
      }));
      return true;
    });
  }

  private async canSendAutomaticNotification(userId: string, repository = this.notificationRepository): Promise<boolean> {
    const since = new Date(Date.now() - AUTOMATIC_NOTIFICATION_COOLDOWN_MS);
    const existingNotification = await repository.findOne({
      where: {
        userId,
        isAutomatic: true,
        // Failed durable work is retried by the outbox, not duplicated by another cron.
        status: In([NotificationStatus.PENDING, NotificationStatus.SENT, NotificationStatus.FAILED]),
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
    if (savedNotification.data?.type === 'app_update' && savedNotification.data?.installationId) {
      // Resolve the fresh token again at the last boundary, including retries.
      const token = this.configService.get<string>('APP_UPDATES_ENABLED') === 'true'
        ? await installationUpdateToken(this.notificationRepository.manager, savedNotification.data) : null;
      if (!token) {
        await this.suppressCriticalNotification(savedNotification, 'INSTALLATION_UPDATE_NO_LONGER_ELIGIBLE');
        return false;
      }
      savedNotification.fcmToken = token;
    }
    const driverRequest = isDriverRequestNotification(savedNotification.data);
    if (driverRequest && !savedNotification.userId) {
      await this.suppressCriticalNotification(savedNotification, 'DRIVER_REQUEST_RECIPIENT_REQUIRED');
      return false;
    }
    // A queued token snapshot is not proof that the device still belongs to this account.
    if (savedNotification.userId) {
      const owner = await this.userRepository.findOne({
        where: { id: savedNotification.userId }, select: ['id', 'fcmToken', 'role', 'isActive', 'status'],
      });
      // Recheck at delivery, including retries: eligibility may have changed since enqueueing.
      if (driverRequest && !canReceiveDriverRequests(owner)) {
        await this.suppressCriticalNotification(savedNotification, 'DRIVER_REQUEST_RECIPIENT_REQUIRED');
        return false;
      }
      savedNotification.fcmToken = owner?.fcmToken?.trim() ?? '';
    }
    if (driverRequest) {
      let passengerId: string | undefined;
      try {
        passengerId = await resolveDriverRequestOwner(this.notificationRepository.manager, savedNotification.data);
      } catch {
        await this.markNotificationFailed(savedNotification, 'DRIVER_REQUEST_OWNER_CHECK_FAILED');
        return false;
      }
      if (!passengerId || passengerId === savedNotification.userId) {
        await this.suppressCriticalNotification(savedNotification,
          passengerId ? 'DRIVER_REQUEST_SELF_NOTIFICATION' : 'DRIVER_REQUEST_OWNER_UNAVAILABLE');
        return false;
      }
      // Preserve ownership on legacy retries and on both FCM/APNs payloads.
      savedNotification.data = { ...savedNotification.data, passengerId, notificationId: savedNotification.id };
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
      if (isNearbyRingingRequest(savedNotification.data) &&
          !await prepareNearbyRequestRinging(this.notificationRepository.manager, savedNotification)) {
        await this.suppressCriticalNotification(savedNotification, 'NEARBY_REQUEST_INVALID_OR_HANDLED');
        return false;
      }
      this.logger.debug(
        `Sending notification through ${this.isExpoPushToken(pushToken) ? 'Expo' : 'FCM'} - Title: ${savedNotification.title}`,
      );
      if (!await renewPushClaim(this.notificationRepository, savedNotification)) return false;
      const messageId = this.isExpoPushToken(pushToken)
        ? await this.sendExpoPushNotification(savedNotification, pushToken)
        : await this.sendFirebaseNotification(savedNotification, pushToken);

      // Mettre à jour la notification avec le statut de succès
      savedNotification.status = NotificationStatus.SENT;
      savedNotification.messageId = messageId;
      savedNotification.errorMessage = null;
      const completed = await saveNotificationResult(this.notificationRepository, savedNotification);

      // Realtime has its own durable claim and never waits for this HTTP send.

      this.logger.log(
        `Notification sent successfully - Title: ${savedNotification.title}, MessageId: ${messageId}`,
      );
      return completed;
    } catch (error) {
      const message = this.getErrorMessage(error);
      await this.markNotificationFailed(savedNotification, message);
      if (this.isInvalidPushTokenError(error)) {
        await this.clearInvalidPushToken(savedNotification.userId, pushToken);
        await this.clearInvalidInstallationToken(savedNotification, pushToken);
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
    if (notification.data?.type === 'app_update') {
      return getMessaging(this.firebaseApp).send({ token: pushToken,
        notification: { title: notification.title, body: notification.body },
        data: this.stringifyNotificationData(notification.data),
        android: { priority: 'normal', ttl: 86_400_000, notification: { channelId: 'zwanga_default' } },
        apns: { headers: { 'apns-expiration': String(Math.floor(Date.now() / 1000) + 86_400) }, payload: { aps: { sound: 'default' } } },
      });
    }
    const send = (message: import('firebase-admin/messaging').Message) =>
      URGENT_NOTIFICATION_TYPES.includes(notification.data?.type)
        ? sendBoundedFirebase(this.firebaseApp, message) : getMessaging(this.firebaseApp).send(message);
    const version = await this.driverActionVersion(notification, pushToken);
    if (version === 6 || (this.isNearbyRequestRing(notification) && await this.ringClientVersion(notification, pushToken) === 6)) {
      notification.data = { ...notification.data, nativeDeliveryVersion: 6 };
      return send(nativeAndroidDriverPush(notification, pushToken, this.driverRingUntil(notification)));
    }
    if (version === 5 || ((this.isNearbyRequestRing(notification) || this.isPassengerRideResponse(notification)) &&
        await this.ringClientVersion(notification, pushToken) === 5)) {
      const iosNotification = this.isPassengerRideResponse(notification)
        ? { ...notification, data: this.passengerRingData(notification) } : notification;
      return send(iosDriverPush(iosNotification, pushToken, this.driverRingUntil(notification)));
    }
    if (version > 0) {
      const ringUntil = version >= 2 ? this.driverRingUntil(notification) : undefined;
      // v1-v3 stay headless. v4 adds a quiet native Expo safety card while
      // Notifee owns the sound and interactive card if the JS task runs.
      const data = { ...notification.data, actionProtocol: 'driver-v1', invitationText: notification.body,
        ...(ringUntil ? { ringVersion: 'v2', ringUntil } : {}) };
      return send({ token: pushToken,
        data: this.stringifyNotificationData(version >= 4 ? androidDriverBackup(notification, data) : data),
        android: { priority: 'high', ttl: version >= 4 ? androidDriverBackupTtl(notification) : this.driverNotificationTtl(notification, ringUntil) * 1000 },
      });
    }
    const passengerRing = this.isPassengerRideResponse(notification) &&
      await this.ringClientVersion(notification, pushToken) >= 2;
    const nearbyVersion = this.isNearbyRequestRing(notification)
      ? await this.ringClientVersion(notification, pushToken) : 0;
    const nearbyRing = nearbyVersion >= 2;
    // Capability registration may be delayed, or invalidated by token rotation.
    // Preserve an OS-visible alert for those devices instead of relying on JS.
    const ordinaryDriverAlert = this.isDriverRingInvitation(notification) || this.isNearbyRequestRing(notification);
    if (nearbyVersion >= 3) {
      // Local Notifee owns the finite ringtone. FCM alert sound has
      // no playback timeout (TTL only bounds delivery), so never play it twice.
      const ringUntil = this.driverRingUntil(notification);
      return send({ token: pushToken,
        data: this.stringifyNotificationData(nearbyVersion >= 4
          ? androidDriverBackup(notification, { ...notification.data, delivery: 'driver-phone-v3', invitationText: notification.body, ringUntil })
          : { ...notification.data, delivery: 'driver-phone-v3', invitationText: notification.body, ringUntil }),
        android: { priority: 'high', ttl: nearbyVersion >= 4 ? androidDriverBackupTtl(notification) : this.driverNotificationTtl(notification, ringUntil) * 1000 },
      });
    }
    return send({
      token: pushToken,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: this.stringifyNotificationData(passengerRing
        ? this.passengerRingData(notification) : nearbyRing
          ? { ...notification.data, ringUntil: this.driverRingUntil(notification) } : notification.data),
      ...(passengerRing || nearbyRing ? { android: { priority: 'high' as const,
        ttl: nearbyRing ? this.driverNotificationTtl(notification, this.driverRingUntil(notification)) * 1000 : 60_000,
        notification: { channelId: 'booking-ring-v2', sound: 'driver_ring',
          tag: nearbyRing ? `request-nearby-${notification.data?.tripRequestId}`
            : `ride-response-${notification.data?.bookingId ?? notification.data?.tripRequestId}`, visibility: 'private' as const } } }
        : ordinaryDriverAlert ? { android: { priority: 'high' as const,
          ttl: this.driverNotificationTtl(notification, this.driverRingUntil(notification)) * 1000,
          notification: { channelId: 'zwanga_default', sound: 'default', visibility: 'private' as const,
            tag: `${notification.data?.type}-${notification.data?.offerId ?? notification.data?.bookingId ?? notification.data?.tripRequestId}` } } } : {}),
    });
  }

  private async sendExpoPushNotification(
    notification: Notification,
    pushToken: string,
  ): Promise<string> {
    const version = await this.driverActionVersion(notification, pushToken);
    const driverActions = version > 0;
    const passengerRing = this.isPassengerRideResponse(notification) &&
      await this.ringClientVersion(notification, pushToken) >= 2;
    const nearbyAlert = this.isNearbyRequestRing(notification);
    const nearbyRing = nearbyAlert &&
      await this.ringClientVersion(notification, pushToken) >= 2;
    // APNs can request a bundled sound independently of interactive JS support.
    // An older iOS binary without the file falls back to the system sound. Keep
    // categories and time-sensitive entitlement usage gated by client capability.
    const driverRing = this.isDriverRingInvitation(notification);
    const longRing = driverRing || passengerRing || nearbyRing;
    const timeSensitive = version >= 2 || passengerRing || nearbyRing;
    const ringUntil = driverRing || nearbyAlert ? this.driverRingUntil(notification) : undefined;
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
          ...(version >= 2 ? { ringVersion: 'v2', ringUntil } : {}) }
          : passengerRing ? this.passengerRingData(notification)
          : nearbyAlert ? { ...notification.data, ringUntil } : notification.data ?? undefined,
        ...(driverActions ? { categoryId: version >= 2 ? 'driver-offer-v2' : 'driver-offer-v1' } : {}),
        ...(driverRing || nearbyAlert ? { ttl: this.driverNotificationTtl(notification, ringUntil) } : {}),
        ...(timeSensitive ? { interruptionLevel: 'time-sensitive' } : {}),
        ...(passengerRing ? { ttl: 60 } : {}),
        ...(notification.data?.type === 'app_update' ? { ttl: 86400 } : {}),
        ...(version >= 2 || passengerRing || nearbyRing ? { channelId: 'booking-ring-v2' } : {}),
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

  private isPassengerRideResponse(notification: Notification): boolean {
    return notification.data?.type === 'trip_request_accepted' ||
      (notification.data?.type === 'booking_response' &&
        (!notification.data.status || ['accepted', 'rejected'].includes(notification.data.status)));
  }

  private passengerRingData(notification: Notification): Record<string, unknown> {
    return { ...notification.data, passengerId: notification.userId, role: 'passenger',
      ringAlert: notification.data?.type === 'booking_response' ? 'booking-response-v1' : 'request-accepted-v1',
      ringUntil: this.driverRingUntil(notification) };
  }

  /** A stale booking stays actionable in-app, but must not ring an hour later. */
  private driverRingUntil(notification: Notification): string {
    const expiry = Date.parse(String(notification.data?.alertExpiresAt ?? notification.data?.expiresAt ?? ''));
    const createdAt = new Date(notification.createdAt).getTime();
    const deadline = (Number.isFinite(createdAt) ? createdAt : Date.now()) + 60_000;
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

  private isNearbyRequestRing(notification: Notification): boolean {
    return notification.data?.type === 'trip_request_nearby' && notification.data.ringAlert === 'nearby-request-v1' &&
      Boolean(notification.userId && notification.data.driverId === notification.userId) &&
      this.configService.get<string>('DRIVER_DISPATCH_ENABLED') === 'true';
  }

  private async ringClientVersion(notification: Notification, pushToken: string): Promise<number> {
    if (!notification.userId) return 0;
    const rows: { version: number }[] = await this.notificationRepository.manager.query(
      `SELECT CASE WHEN "tokenHash" = $7 THEN 6 WHEN "tokenHash" = $6 THEN 5 WHEN "tokenHash" = $5 THEN 4 WHEN "tokenHash" = $4 THEN 3 WHEN "tokenHash" = $3 THEN 2 ELSE 1 END AS version FROM driver_notification_clients
        WHERE "userId" = $1 AND "tokenHash" IN ($2,$3,$4,$5,$6,$7)`,
      [notification.userId, createHash('sha256').update(pushToken).digest('hex'),
        createHash('sha256').update(pushToken + ':driver-v2').digest('hex'),
        createHash('sha256').update(pushToken + ':driver-v3').digest('hex'),
        createHash('sha256').update(pushToken + ':driver-v4').digest('hex'),
        createHash('sha256').update(pushToken + ':driver-v5').digest('hex'),
        createHash('sha256').update(pushToken + ':driver-v6').digest('hex')]);
    return rows.length > 0 ? ([2, 3, 4, 5, 6].includes(rows[0].version) ? rows[0].version : 1) : 0;
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

  private async clearInvalidInstallationToken(notification: Notification, token: string): Promise<void> {
    if (notification.data?.type !== 'app_update' || !notification.data?.installationId) return;
    // A delayed provider error for an old token must not disable its replacement.
    await this.notificationRepository.manager.query(`UPDATE app_update_installations SET enabled=false, "pushToken"=NULL
      WHERE id=$1 AND "pushToken"=$2`, [notification.data.installationId, token]);
  }

  private async markNotificationFailed(
    notification: Notification,
    message: string,
  ): Promise<void> {
    notification.status = NotificationStatus.FAILED;
    notification.messageId = null;
    notification.errorMessage = message;
    await saveNotificationResult(this.notificationRepository, notification);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** Deliver newly committed outbox rows without holding business/database locks over HTTP. */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async dispatchTransactionalNotifications(): Promise<void> {
    await Promise.all([this.dispatchNotificationLane(false), this.dispatchUrgentNotifications(), this.dispatchRealtimeNotifications()]);
  }

  /** Independent from FCM/Expo capacity. Emits only authenticated business recipients. */
  @Cron('*/2 * * * * *')
  async dispatchRealtimeNotifications(): Promise<void> {
    if (this.dispatchingRealtime || !this.rideAlerts?.isBound()) return;
    this.dispatchingRealtime = true;
    const manager = this.notificationRepository.manager;
    try {
      const ids = await claimRideRealtimeNotifications(manager);
      if (!ids.length) return;
      const rows = await this.notificationRepository.findBy({ id: In(ids) });
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(5, rows.length) }, async () => {
        while (next < rows.length) {
          const row = rows[next++];
          try {
            await this.publishRealtimeInvitation(row);
            await manager.query(`UPDATE ride_realtime_deliveries SET "completedAt" = clock_timestamp()
              WHERE "notificationId" = $1`, [row.id]);
          } catch {
            // Lease retries after 5s, never after the original invitation expires.
            this.logger.warn(`Ride realtime delivery deferred notificationId=${row.id}`);
          }
        }
      }));
    } catch { this.logger.warn('Ride realtime batch deferred.'); }
    finally { this.dispatchingRealtime = false; }
  }

  private async publishRealtimeInvitation(notification: Notification): Promise<void> {
    if (!notification.userId || !notification.isActive ||
        !(await this.isCriticalNotificationStillDeliverable(notification))) return;
    const owner = await this.userRepository.findOne({ where: { id: notification.userId },
      select: ['id', 'role', 'isActive', 'status'] });
    if (!canReceiveDriverRequests(owner)) return;
    const passengerId = await resolveDriverRequestOwner(this.notificationRepository.manager, notification.data);
    if (!passengerId || passengerId === notification.userId) return;
    notification.data = { ...notification.data, passengerId, notificationId: notification.id };
    if (isNearbyRingingRequest(notification.data) &&
        !await prepareNearbyRequestRinging(this.notificationRepository.manager, notification)) return;
    const ringUntil = this.driverRingUntil(notification);
    if (Date.parse(ringUntil) <= Date.now()) return;
    if (!this.rideAlerts?.publish(notification.userId, {
      kind: 'incoming', eventId: notification.id,
      data: { ...notification.data, actionProtocol: 'driver-v1', delivery: 'driver-phone-v3',
        invitationText: notification.body, ringVersion: 'v2', ringUntil },
    })) throw new Error('Realtime transport unavailable');
  }

  private reconcilingNearbyRequests = false;

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileNearbyRequestRinging(): Promise<void> {
    if (this.reconcilingNearbyRequests) return;
    this.reconcilingNearbyRequests = true;
    try { await reconcileNearbyRequestCooldowns(this.notificationRepository.manager); }
    catch { this.logger.warn('Nearby request ringing event reconciliation deferred.'); }
    finally { this.reconcilingNearbyRequests = false; }
  }

  @Cron('*/5 * * * * *')
  async dispatchUrgentNotifications(): Promise<void> {
    try { await recoverUnacknowledgedRides(this.notificationRepository.manager); }
    catch { this.logger.warn('Native delivery acknowledgement recovery deferred.'); }
    // Starting push delivery must never occupy the realtime lane's capacity.
    void this.dispatchRealtimeNotifications().catch(() => this.logger.warn('Ride realtime delivery deferred.'));
    // Drain a broadcast promptly when the provider is fast, without increasing
    // the five-worker cap or claiming a large backlog behind a slow request.
    const startedAt = Date.now();
    for (let batch = 0; batch < 20; batch += 1) {
      const processed = await this.dispatchNotificationLane(true);
      if (processed === 0 || Date.now() - startedAt >= 2_000) break;
    }
  }

  private async dispatchNotificationLane(urgent: boolean): Promise<number> {
    if (urgent) {
      if (this.dispatchingUrgentNotifications || this.urgentWorkers >= 5) return 0;
      this.dispatchingUrgentNotifications = true;
    } else {
      if (this.dispatchingTransactionalNotifications) return 0;
      this.dispatchingTransactionalNotifications = true;
    }
    let claimReleased = false;
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
                leaseBefore: new Date(Date.now() - PUSH_CLAIM_LEASE_MS),
              })
              .andWhere('notification.isActive = true')
              .orderBy(urgent ? "CASE WHEN notification.data ->> 'type' = 'driver_dispatch_offer' THEN 0 ELSE 1 END" : 'notification.createdAt', 'ASC')
              .addOrderBy('notification.createdAt', 'ASC')
              .addOrderBy('notification.id', 'ASC')
              .take(urgent ? 5 - this.urgentWorkers : CRITICAL_RETRY_BATCH_SIZE)
              .setLock('pessimistic_write')
              .setOnLocked('skip_locked')
              .getMany();
            for (const row of rows) {
              row.status = NotificationStatus.PENDING;
              row.errorMessage = `TRANSACTIONAL_PUSH_CLAIMED:${randomUUID()}`;
            }
            return rows.length ? repository.save(rows) : rows;
          },
        );
      // Release the urgent claim gate before HTTP: the next tick can use free
      // slots while a previous provider request is slow. Never race a timeout
      // against an uncancelled send, which could duplicate delivery.
      const workerCount = Math.min(urgent ? 5 - this.urgentWorkers : 5, notifications.length);
      if (urgent) {
        this.urgentWorkers += workerCount;
        this.dispatchingUrgentNotifications = false;
        claimReleased = true;
      }
      let next = 0;
      await Promise.all(Array.from({ length: workerCount }, async () => {
        try {
          while (next < notifications.length) {
            const notification = notifications[next++];
            const deliveryStartedAt = Date.now();
            ownPushClaim(notification, notification.errorMessage!);
            const stopHeartbeat = heartbeatPushClaim(this.notificationRepository, notification,
              () => this.logger.warn('Push claim renewal deferred.'));
            try {
              // Retry transport only: the original server deadline is immutable.
              // Relevance below rejects expired invitations instead of reviving them.
              if (
                !(await this.isCriticalNotificationStillDeliverable(
                  notification,
                ))
              ) {
                await this.suppressCriticalNotification(
                  notification,
                  'Notification transactionnelle remplacée par un état plus récent',
                );
                continue;
              }
              await this.deliverSavedNotification(notification);
            } catch (error) {
              // A crashed/failed delivery is recovered by the existing stale-claim retry.
              this.logger.error(
                `TRANSACTIONAL_PUSH_FAILED notificationId=${notification.id}: ${this.getErrorMessage(error)}`,
              );
            } finally {
              stopHeartbeat();
              const elapsedMs = Date.now() - deliveryStartedAt;
              if (elapsedMs >= PUSH_DELIVERY_TIMEOUT_MS) this.logger.warn(`TRANSACTIONAL_PUSH_SLOW urgent=${urgent} elapsedMs=${elapsedMs}`);
            }
          }
        } finally {
          if (urgent) this.urgentWorkers -= 1;
        }
      }));
      return notifications.length;
    } finally {
      // Only release our claim gate on a failed claim. Once delivery starts,
      // another tick may own the gate, so do not overwrite it here.
      if (urgent) {
        if (!claimReleased) this.dispatchingUrgentNotifications = false;
      } else this.dispatchingTransactionalNotifications = false;
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

      if (!notification.userId && !(notification.data?.type === 'app_update' && notification.data?.installationId)) {
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
    if (type === 'booking_response' || type === 'trip_request_accepted') {
      return isRideResponseDeliverable(this.notificationRepository.manager, notification);
    }
    if (type === 'driver_location_stale') {
      if (this.configService.get<string>('DRIVER_DISPATCH_ENABLED') !== 'true') return false;
      return isStaleLocationReminderDeliverable(this.notificationRepository.manager, notification);
    }
    if (notification.eventKey && ['trip_departure_reminder', 'trip_expiring_soon'].includes(type)) {
      return isTripReminderDeliverable(this.notificationRepository.manager, notification);
    }
    if (type === 'trip_request_nearby') {
      if (!this.isNearbyRequestRing(notification) ||
          !(Date.parse(String(notification.data?.alertExpiresAt)) > Date.now())) return false;
      if ((notification.data?.sharedTrip === true || notification.data?.sharedTrip === 'true') &&
          !(await sharedTripAlertIsDeliverable(this.notificationRepository.manager, notification.userId,
            notification.data?.tripRequestId, notification.data?.existingTripId))) return false;
      const rows: { passengerId: string }[] = await this.notificationRepository.manager.query(`SELECT r."passengerId" FROM trip_requests r
        WHERE r.id = $1 AND r.status IN ('pending', 'offers_received') AND r."selectedDriverId" IS NULL
          AND r."tripId" IS NULL AND r."departureDateMax" > now() AND r."passengerId" <> $2`,
        [notification.data?.tripRequestId, notification.userId]);
      if (rows[0]?.passengerId) notification.data = { ...notification.data, passengerId: rows[0].passengerId };
      return rows.length > 0;
    }
    if (type === 'new_booking') {
      const rows: unknown[] = await this.notificationRepository.manager.query(`SELECT 1 FROM bookings b
        JOIN trips t ON t.id = b."tripId" WHERE b.id = $1 AND t."driverId" = $2
        AND b.status = 'pending' AND t.status IN ('upcoming', 'ongoing')
        AND t."tripRequestId" IS NULL`, [notification.data?.bookingId, notification.userId]);
      return rows.length > 0;
    }
    if (type === 'app_update') {
      if (this.configService.get<string>('APP_UPDATES_ENABLED') !== 'true') return false;
      if (notification.data?.installationId) return Boolean(await installationUpdateToken(this.notificationRepository.manager, notification.data));
      return isAppUpdateDeliverable(this.notificationRepository.manager, notification.data?.releaseId, notification.userId);
    }
    if (type === 'driver_dispatch_offer') {
      if (this.configService.get<string>('DRIVER_DISPATCH_ENABLED') !== 'true') return false;
      const rows: { passengerId: string }[] = await this.notificationRepository.manager.query(`SELECT r."passengerId" FROM trip_request_dispatch_offers o
        JOIN trip_requests r ON r.id = o."requestId" WHERE o.id = $1 AND o."driverId" = $2
        AND o.status = 'pending' AND o."expiresAt" > now() AND r.status = 'pending' AND r."passengerId" <> $2
        AND r."selectedDriverId" IS NULL AND r."tripId" IS NULL AND r."departureDateMax" > now()
        AND r."maxPricePerSeat" IS NOT NULL`,
        [notification.data?.offerId, notification.userId]);
      if (rows[0]?.passengerId) notification.data = { ...notification.data, passengerId: rows[0].passengerId };
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
    await saveNotificationResult(this.notificationRepository, notification);
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
          await saveNotificationResult(this.notificationRepository, notification);
          continue;
        }
        if (receipt.status === 'ok') {
          notification.messageId = `${EXPO_RECEIPT_OK_PREFIX}${receiptId}`;
          notification.errorMessage = null;
          await saveNotificationResult(this.notificationRepository, notification);
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
          await this.clearInvalidInstallationToken(notification, notification.fcmToken);
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
    if (isDriverRequestNotification(data) && !userIds?.length) {
      this.logger.warn('Driver request alerts require identified recipients');
      return;
    }
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

          await saveNotificationResult(this.notificationRepository, notification);
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
        await saveNotificationResult(this.notificationRepository, notification);
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
      .andWhere('notification.isActive = true')
      .andWhere(
        `(COALESCE(notification.data ->> 'type', '') NOT IN (:...driverRequestTypes)
          OR EXISTS (SELECT 1 FROM users viewer WHERE viewer.id = :userId
            AND viewer.role = :notificationDriverRole AND viewer."isActive" = true
            AND viewer.status NOT IN (:...inactiveDriverStatuses)))`,
        {
          driverRequestTypes: [...DRIVER_REQUEST_NOTIFICATION_TYPES],
          notificationDriverRole: UserRole.DRIVER,
          inactiveDriverStatuses: [UserStatus.SUSPENDED, UserStatus.INACTIVE],
        },
      );

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
