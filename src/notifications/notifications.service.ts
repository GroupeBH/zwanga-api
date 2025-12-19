import * as admin from 'firebase-admin';
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationStatus } from './entities/notification.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private firebaseApp: admin.app.App;

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
    const credentialsBase64 = this.configService.get<string>('FCM_CREDENTIALS_BASE64');

    if (credentialsBase64) {
      // Option 1: Utiliser le fichier JSON complet encodé en base64
      try {
        const credentialsJson = Buffer.from(credentialsBase64, 'base64').toString('utf-8');
        const credentials = JSON.parse(credentialsJson);
        this.firebaseApp = admin.initializeApp({
          credential: admin.credential.cert(credentials),
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
        const privateKey = Buffer.from(privateKeyBase64, 'base64').toString('utf-8');
        
        this.firebaseApp = admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            privateKey: privateKey.replace(/\\n/g, '\n'),
            clientEmail,
          }),
        });
        this.logger.log('FCM initialized successfully with individual credentials');
      } catch (error) {
        this.logger.error('Error initializing FCM with individual credentials:', error);
      }
    }
  }

  async sendNotification(
    fcmToken: string,
    title: string,
    body: string,
    data?: Record<string, any>,
    userId?: string,
  ): Promise<void> {
    if (!this.firebaseApp) {
      this.logger.warn('FCM not configured, skipping notification');
      return;
    }

    // Créer l'enregistrement de notification en base de données
    const notification = this.notificationRepository.create({
      userId: userId || null,
      fcmToken,
      title,
      body,
      data: data || null,
      status: NotificationStatus.PENDING,
    });

    // Sauvegarder la notification en attente
    const savedNotification = await this.notificationRepository.save(notification);

    try {
      this.logger.debug(`Sending notification to token: ${fcmToken.substring(0, 10)}... - Title: ${title}`);
      
      const messageId = await admin.messaging().send({
        token: fcmToken,
        notification: {
          title,
          body,
        },
        data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
      });
      
      // Mettre à jour la notification avec le statut de succès
      savedNotification.status = NotificationStatus.SENT;
      savedNotification.messageId = messageId;
      await this.notificationRepository.save(savedNotification);
      
      this.logger.log(`Notification sent successfully - Title: ${title}, MessageId: ${messageId}`);
    } catch (error) {
      // Mettre à jour la notification avec le statut d'échec
      savedNotification.status = NotificationStatus.FAILED;
      savedNotification.errorMessage = error.message;
      await this.notificationRepository.save(savedNotification);
      
      this.logger.error(`Error sending notification: ${error.message}`, error.stack);
    }
  }

  async sendToMultiple(
    fcmTokens: string[],
    title: string,
    body: string,
    data?: Record<string, any>,
    userIds?: string[],
  ): Promise<void> {
    if (!this.firebaseApp || fcmTokens.length === 0) {
      this.logger.debug('FCM not configured or no tokens provided, skipping multicast notification');
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
        status: NotificationStatus.PENDING,
      }),
    );

    // Sauvegarder toutes les notifications en attente
    const savedNotifications = await this.notificationRepository.save(notifications);

    try {
      this.logger.log(`Sending multicast notification to ${fcmTokens.length} tokens - Title: ${title}`);
      
      const message = {
        notification: {
          title,
          body,
        },
        data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
        tokens: fcmTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      
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
            notification.errorMessage = notificationResponse.error?.message || 'Unknown error';
          }

          await this.notificationRepository.save(notification);
        }
      }
      
      this.logger.log(`Multicast notification sent - Success: ${response.successCount}, Failed: ${response.failureCount}`);
    } catch (error) {
      // Marquer toutes les notifications comme échouées en cas d'erreur globale
      for (const notification of savedNotifications) {
        notification.status = NotificationStatus.FAILED;
        notification.errorMessage = error.message;
        await this.notificationRepository.save(notification);
      }
      
      this.logger.error(`Error sending multicast notifications: ${error.message}`, error.stack);
    }
  }

  // ==================== Notification Retrieval ====================

  async findAllByUser(userId: string, options?: { limit?: number; offset?: number }): Promise<{
    notifications: Notification[];
    total: number;
    unreadCount: number;
  }> {
    this.logger.debug(`Fetching notifications for user ${userId}`);

    // Ne récupérer que les notifications actives (non désactivées)
    const [notifications, total] = await this.notificationRepository.findAndCount({
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

  async markAsRead(userId: string, notificationIds: string[]): Promise<{ updated: number }> {
    this.logger.debug(`Marking ${notificationIds.length} notifications as read for user ${userId}`);

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
    this.logger.debug(`Marking all active notifications as read for user ${userId}`);

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

  async markAsUnread(userId: string, notificationIds: string[]): Promise<{ updated: number }> {
    this.logger.debug(`Marking ${notificationIds.length} notifications as unread for user ${userId}`);

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

  async disableNotifications(userId: string, notificationIds: string[]): Promise<{ updated: number }> {
    this.logger.debug(`Disabling ${notificationIds.length} notifications for user ${userId}`);

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

  async enableNotifications(userId: string, notificationIds: string[]): Promise<{ updated: number }> {
    this.logger.debug(`Enabling ${notificationIds.length} notifications for user ${userId}`);

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

