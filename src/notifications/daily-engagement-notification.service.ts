import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/entities/user.entity';
import { NotificationService } from './notifications.service';
import { activePushUsers } from './active-push-users';

@Injectable()
export class DailyEngagementNotificationService {
  private readonly logger = new Logger(DailyEngagementNotificationService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly notificationService: NotificationService,
  ) {}

  // Every day at 04:00 (Africa/Kinshasa)
  @Cron('0 4 * * *', { timeZone: 'Africa/Kinshasa', waitForCompletion: true })
  async sendDailyProfilePush(): Promise<void> {
    this.logger.log('Running daily engagement push job (04:00 Africa/Kinshasa)');

    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for await (const user of activePushUsers(this.userRepository)) {
      const isDriverProfile = user.role === UserRole.DRIVER;
      const firstName = (user.firstName || '').trim() || 'cher utilisateur';

      const title = `Bonjour ${firstName}`;
      const body = isDriverProfile
        ? "Veux-tu embarquer des nouveaux passagers aujourd'hui ? Publie ton trajet gratuit ou fixe ton prix."
        : 'Commande un trajet et profite de la communaute des conducteurs Zwanga qui vont dans ta direction.';

      try {
        const sent = await this.notificationService.sendAutomaticNotification(
          user.fcmToken!,
          title,
          body,
          {
            type: 'daily_engagement',
            profile: isDriverProfile ? 'driver' : 'passenger',
          },
          user.id,
        );
        if (sent) {
          sentCount += 1;
        } else {
          skippedCount += 1;
        }
      } catch (error) {
        failedCount += 1;
        this.logger.warn(
          `Failed to send daily engagement push to user ${user.id}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Daily engagement push finished - queued: ${sentCount}, skipped: ${skippedCount}, failed: ${failedCount}`,
    );
  }
}
