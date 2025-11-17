import * as admin from 'firebase-admin';
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private firebaseApp: admin.app.App;

  constructor(private configService: ConfigService) {}

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
  ): Promise<void> {
    if (!this.firebaseApp) {
      this.logger.warn('FCM not configured, skipping notification');
      return;
    }

    try {
      this.logger.debug(`Sending notification to token: ${fcmToken.substring(0, 10)}... - Title: ${title}`);
      
      await admin.messaging().send({
        token: fcmToken,
        notification: {
          title,
          body,
        },
        data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
      });
      
      this.logger.log(`Notification sent successfully - Title: ${title}`);
    } catch (error) {
      this.logger.error(`Error sending notification: ${error.message}`, error.stack);
    }
  }

  async sendToMultiple(
    fcmTokens: string[],
    title: string,
    body: string,
    data?: Record<string, any>,
  ): Promise<void> {
    if (!this.firebaseApp || fcmTokens.length === 0) {
      this.logger.debug('FCM not configured or no tokens provided, skipping multicast notification');
      return;
    }

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
      
      this.logger.log(`Multicast notification sent - Success: ${response.successCount}, Failed: ${response.failureCount}`);
    } catch (error) {
      this.logger.error(`Error sending multicast notifications: ${error.message}`, error.stack);
    }
  }
}

