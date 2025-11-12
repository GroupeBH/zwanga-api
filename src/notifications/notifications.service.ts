import * as admin from 'firebase-admin';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NotificationService implements OnModuleInit {
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
        return;
      } catch (error) {
        console.error('Error parsing FCM credentials from base64:', error);
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
      } catch (error) {
        console.error('Error initializing FCM with individual credentials:', error);
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
      console.log('FCM not configured, skipping notification');
      return;
    }

    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: {
          title,
          body,
        },
        data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
      });
    } catch (error) {
      console.error('Error sending notification:', error);
    }
  }

  async sendToMultiple(
    fcmTokens: string[],
    title: string,
    body: string,
    data?: Record<string, any>,
  ): Promise<void> {
    if (!this.firebaseApp || fcmTokens.length === 0) {
      return;
    }

    try {
      const message = {
        notification: {
          title,
          body,
        },
        data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
        tokens: fcmTokens,
      };

      await admin.messaging().sendEachForMulticast(message);
    } catch (error) {
      console.error('Error sending notifications:', error);
    }
  }
}

