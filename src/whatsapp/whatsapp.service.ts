import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface WhatsAppMessage {
  to: string; // Numéro de téléphone au format international (ex: +221771234567)
  message: string;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly from: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    // Configuration pour l'API WhatsApp
    // Vous pouvez utiliser Twilio, WhatsApp Business API, ou un autre service
    this.apiUrl = this.configService.get<string>('WHATSAPP_API_URL') || '';
    this.apiKey = this.configService.get<string>('WHATSAPP_API_KEY') || '';
    this.from = this.configService.get<string>('WHATSAPP_FROM') || 'Zwanga';
  }

  /**
   * Envoie un message WhatsApp à un numéro de téléphone
   */
  async sendMessage(to: string, message: string): Promise<boolean> {
    if (!this.apiUrl || !this.apiKey) {
      this.logger.warn('WhatsApp API not configured, skipping message send');
      return false;
    }

    try {
      this.logger.debug(`Sending WhatsApp message to: ${to}`);

      // Format du numéro (supprimer les espaces et caractères spéciaux, garder le +)
      const formattedPhone = this.formatPhoneNumber(to);

      const response = await firstValueFrom(
        this.httpService.post(
          this.apiUrl,
          {
            to: formattedPhone,
            message,
            from: this.from,
          },
          {
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      this.logger.log(`WhatsApp message sent successfully to ${formattedPhone}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Error sending WhatsApp message to ${to}: ${error.message}`,
        error.stack,
      );
      return false;
    }
  }

  /**
   * Envoie des messages WhatsApp à plusieurs destinataires
   */
  async sendToMultiple(recipients: WhatsAppMessage[]): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const recipient of recipients) {
      const result = await this.sendMessage(recipient.to, recipient.message);
      if (result) {
        success++;
      } else {
        failed++;
      }
    }

    this.logger.log(`WhatsApp messages sent: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  /**
   * Formate un numéro de téléphone pour WhatsApp (format international)
   */
  private formatPhoneNumber(phone: string): string {
    // Supprimer les espaces, tirets, parenthèses
    let formatted = phone.replace(/[\s\-\(\)]/g, '');

    // Si le numéro ne commence pas par +, ajouter l'indicatif par défaut
    // Vous pouvez adapter cela selon votre pays (ex: +221 pour le Sénégal)
    if (!formatted.startsWith('+')) {
      // Par défaut, on suppose que c'est un numéro local et on ajoute +221
      // Vous pouvez configurer cela dans les variables d'environnement
      const defaultCountryCode = this.configService.get<string>('DEFAULT_COUNTRY_CODE') || '+221';
      formatted = defaultCountryCode + formatted;
    }

    return formatted;
  }

  /**
   * Génère un message WhatsApp pour informer les contacts d'urgence d'un trajet
   */
  generateTripNotificationMessage(data: {
    passengerName: string;
    departureLocation: string;
    arrivalLocation: string;
    departureDate: Date;
    vehicleColor: string;
    licensePlate: string;
    driverName?: string;
    driverPhone?: string;
  }): string {
    const formattedDate = new Date(data.departureDate).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    let message = `🚗 *ZWANGA - Information de Trajet*\n\n`;
    message += `Bonjour,\n\n`;
    message += `${data.passengerName} utilise Zwanga pour un trajet et vous a ajouté comme contact d'urgence.\n\n`;
    message += `*Détails du trajet :*\n`;
    message += `📍 Départ : ${data.departureLocation}\n`;
    message += `📍 Arrivée : ${data.arrivalLocation}\n`;
    message += `📅 Date/Heure : ${formattedDate}\n\n`;
    message += `*Informations du véhicule :*\n`;
    message += `🎨 Couleur : ${data.vehicleColor}\n`;
    message += `🔢 Plaque d'immatriculation : ${data.licensePlate}\n\n`;

    if (data.driverName) {
      message += `*Conducteur :*\n`;
      message += `👤 Nom : ${data.driverName}\n`;
      if (data.driverPhone) {
        message += `📱 Téléphone : ${data.driverPhone}\n`;
      }
      message += `\n`;
    }

    message += `En cas d'urgence ou de problème, contactez ${data.passengerName} ou utilisez l'application Zwanga.\n\n`;
    message += `_Message envoyé automatiquement par Zwanga_`;

    return message;
  }
}

