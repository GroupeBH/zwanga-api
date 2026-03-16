import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/entities/user.entity';
import { NotificationService } from './notifications.service';

@Injectable()
export class DailyEngagementNotificationService {
  private readonly logger = new Logger(DailyEngagementNotificationService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly notificationService: NotificationService,
  ) {}

  // Every day at 04:00 (Africa/Kinshasa)
  @Cron('0 4 * * *', { timeZone: 'Africa/Kinshasa' })
  async sendDailyProfilePush(): Promise<void> {
    this.logger.log('Running daily engagement push job (04:00 Africa/Kinshasa)');

    const users = await this.userRepository.find({
      where: { isActive: true },
      select: ['id', 'firstName', 'role', 'isDriver', 'fcmToken'],
    });

    const usersWithToken = users.filter(
      (user) => typeof user.fcmToken === 'string' && user.fcmToken.trim().length > 0,
    );

    if (usersWithToken.length === 0) {
      this.logger.debug('No active users with notification permission/token found');
      return;
    }

    let sentCount = 0;
    let failedCount = 0;

    for (const user of usersWithToken) {
      const isDriverProfile = user.isDriver || user.role === UserRole.DRIVER;
      const firstName = (user.firstName || '').trim() || 'cher utilisateur';

      const title = `Bonjour ${firstName}`;
      const body = isDriverProfile
        ? "Veux-tu embarquer des nouveaux passagers aujourd'hui ? Publie ton trajet gratuit ou fixe ton prix."
        : 'Demande un trajet et profite de la communaute des conducteurs Zwanga qui vont dans ta direction.';

      try {
        await this.notificationService.sendNotification(
          user.fcmToken!,
          title,
          body,
          {
            type: 'daily_engagement',
            profile: isDriverProfile ? 'driver' : 'passenger',
          },
          user.id,
        );
        sentCount += 1;
      } catch (error) {
        failedCount += 1;
        this.logger.warn(
          `Failed to send daily engagement push to user ${user.id}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Daily engagement push finished - sent: ${sentCount}, failed: ${failedCount}, total eligible: ${usersWithToken.length}`,
    );
  }
}

