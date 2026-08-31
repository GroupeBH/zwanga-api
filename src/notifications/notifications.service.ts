import {
  cert,
  initializeApp,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
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

const AUTOMATIC_NOTIFICATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_RECEIPTS_API_URL =
  'https://exp.host/--/api/v2/push/getReceipts';
const PUSH_DELIVERY_TIMEOUT_MS = 10_000;
const CRITICAL_RETRY_DELAY_MS = 5 * 60 * 1000;
const CRITICAL_RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;
const CRITICAL_RETRY_BATCH_SIZE = 25;
const EXPO_RECEIPT_DELAY_MS = 15 * 60 * 1000;
const EXPO_RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const EXPO_RECEIPT_BATCH_SIZE = 100;
const EXPO_TICKET_PREFIX = 'expo-ticket:';
const EXPO_RECEIPT_OK_PREFIX = 'expo-receipt-ok:';
const EXPO_RECEIPT_CHECKING = 'EXPO_RECEIPT_CHECKING';
const CRITICAL_NOTIFICATION_TYPES = [
  'driver_trip_revenue',
  'driver_booking_earning_confirmed',
] as const;

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

  constructor(
    private configService: ConfigService,
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
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
      throw new Error('FCM non configure sur le serveur');
    }
    return getMessaging(this.firebaseApp).send({
      token: pushToken,
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: this.stringifyNotificationData(notification.data),
    });
  }

  private async sendExpoPushNotification(
    notification: Notification,
    pushToken: string,
  ): Promise<string> {
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
        data: notification.data ?? undefined,
        sound: 'default',
        priority: 'high',
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
          'Expo Push a refuse la notification',
      ) as Error & { code?: string };
      error.code = `expo/${ticket?.details?.error || payload.errors?.[0]?.code || 'unknown'}`;
      throw error;
    }
    return ticket.id
      ? `${EXPO_TICKET_PREFIX}${ticket.id}`
      : `${EXPO_RECEIPT_OK_PREFIX}accepted-${notification.id}`;
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

  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryCriticalFinancialNotifications(): Promise<void> {
    const notifications = await this.claimCriticalFinancialNotifications();
    if (notifications.length === 0) {
      return;
    }

    let delivered = 0;
    for (const notification of notifications) {
      if (!notification.userId) {
        await this.markNotificationFailed(
          notification,
          'Notification financiere sans utilisateur destinataire',
        );
        continue;
      }
      const user = await this.userRepository.findOne({
        where: { id: notification.userId },
        select: ['id', 'fcmToken'],
      });
      notification.fcmToken = user?.fcmToken?.trim() ?? '';
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
        .andWhere("notification.data ->> 'type' IN (:...types)", {
          types: [...CRITICAL_NOTIFICATION_TYPES],
        })
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
          receipt.message || 'Expo Push receipt a signale un echec',
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
        .andWhere("notification.data ->> 'type' IN (:...types)", {
          types: [...CRITICAL_NOTIFICATION_TYPES],
        })
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
    if (!this.firebaseApp || fcmTokens.length === 0) {
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
    options?: { limit?: number; offset?: number },
  ): Promise<{
    notifications: Notification[];
    total: number;
    unreadCount: number;
  }> {
    this.logger.debug(`Fetching notifications for user ${userId}`);

    // Ne récupérer que les notifications actives (non désactivées)
    const [notifications, total] =
      await this.notificationRepository.findAndCount({
        where: { userId, isActive: true },
        order: { createdAt: 'DESC' },
        take: options?.limit,
        skip: options?.offset,
      });

    // Compter uniquement les notifications non lues et actives
    const unreadCount = await this.notificationRepository.count({
      where: { userId, isRead: false, isActive: true },
    });

    return {
      notifications,
      total,
      unreadCount,
    };
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
