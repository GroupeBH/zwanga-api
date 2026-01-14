import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThan, IsNull } from 'typeorm';
import { EmergencyContact } from './entities/emergency-contact.entity';
import { SafetyAlert, SafetyAlertType, SafetyAlertStatus } from './entities/safety-alert.entity';
import { UserReport, ReportReason, ReportStatus } from './entities/user-report.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { CreateEmergencyContactDto, UpdateEmergencyContactDto } from './dto/emergency-contact.dto';
import { CreateSafetyAlertDto, UpdateSafetyAlertStatusDto, UpdateLocationDto } from './dto/safety-alert.dto';
import { CreateUserReportDto, UpdateReportStatusDto } from './dto/user-report.dto';
import { NotificationService } from '../notifications/notifications.service';
import { Cron, CronExpression } from '@nestjs/schedule';

export interface SanitizedEmergencyContact {
  id: string;
  name: string;
  phone: string;
  relationship: string | null;
  isActive: boolean;
  createdAt: Date;
}

export interface SanitizedSafetyAlert {
  id: string;
  userId: string;
  tripId: string | null;
  bookingId: string | null;
  type: SafetyAlertType;
  status: SafetyAlertStatus;
  message: string | null;
  latitude: number | null;
  longitude: number | null;
  batteryLevel: number | null;
  lastLocationUpdate: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface SanitizedUserReport {
  id: string;
  reporterId: string;
  reportedUserId: string;
  reason: ReportReason;
  description: string;
  status: ReportStatus;
  tripId: string | null;
  bookingId: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}

@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);
  private readonly LOCATION_UPDATE_TIMEOUT = 5 * 60 * 1000; // 5 minutes en millisecondes
  private readonly LOW_BATTERY_THRESHOLD = 15; // 15% de batterie

  constructor(
    @InjectRepository(EmergencyContact)
    private readonly emergencyContactRepository: Repository<EmergencyContact>,
    @InjectRepository(SafetyAlert)
    private readonly safetyAlertRepository: Repository<SafetyAlert>,
    @InjectRepository(UserReport)
    private readonly userReportRepository: Repository<UserReport>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Trip)
    private readonly tripRepository: Repository<Trip>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    private readonly notificationService: NotificationService,
  ) {}

  // ==================== Emergency Contacts ====================

  async createEmergencyContact(
    userId: string,
    createDto: CreateEmergencyContactDto,
  ): Promise<SanitizedEmergencyContact> {
    this.logger.debug(`Creating emergency contact for user ${userId}`);

    // Vérifier le nombre de contacts existants (actifs ou non)
    const existingContactsCount = await this.emergencyContactRepository.count({
      where: { userId },
    });

    const MAX_EMERGENCY_CONTACTS = 5;
    if (existingContactsCount >= MAX_EMERGENCY_CONTACTS) {
      throw new BadRequestException(
        `Vous ne pouvez pas avoir plus de ${MAX_EMERGENCY_CONTACTS} contacts d'urgence. Veuillez supprimer un contact existant avant d'en ajouter un nouveau.`
      );
    }

    const contact = this.emergencyContactRepository.create({
      ...createDto,
      userId,
    });

    const saved = await this.emergencyContactRepository.save(contact);
    return this.sanitizeEmergencyContact(saved);
  }

  async createMultipleEmergencyContacts(
    userId: string,
    createDtos: CreateEmergencyContactDto[],
  ): Promise<SanitizedEmergencyContact[]> {
    this.logger.debug(`Creating ${createDtos.length} emergency contacts for user ${userId}`);

    const MAX_EMERGENCY_CONTACTS = 5;
    
    // Vérifier le nombre de contacts existants
    const existingContactsCount = await this.emergencyContactRepository.count({
      where: { userId },
    });

    // Vérifier que le total ne dépasse pas la limite
    const totalAfterCreation = existingContactsCount + createDtos.length;
    if (totalAfterCreation > MAX_EMERGENCY_CONTACTS) {
      const remainingSlots = MAX_EMERGENCY_CONTACTS - existingContactsCount;
      throw new BadRequestException(
        `Vous ne pouvez pas ajouter ${createDtos.length} contacts. Vous avez déjà ${existingContactsCount} contact(s) et pouvez en ajouter au maximum ${remainingSlots} de plus (limite totale : ${MAX_EMERGENCY_CONTACTS}).`
      );
    }

    // Vérifier qu'il n'y a pas de doublons dans la liste fournie
    const phones = createDtos.map(dto => dto.phone);
    const uniquePhones = new Set(phones);
    if (uniquePhones.size !== phones.length) {
      throw new BadRequestException(
        'Vous ne pouvez pas ajouter plusieurs contacts avec le même numéro de téléphone.'
      );
    }

    // Vérifier qu'aucun numéro n'existe déjà dans la base de données
    const existingContacts = await this.emergencyContactRepository.find({
      where: { userId },
    });
    const existingPhones = new Set(existingContacts.map(c => c.phone));
    const duplicatePhones = phones.filter(phone => existingPhones.has(phone));
    if (duplicatePhones.length > 0) {
      throw new BadRequestException(
        `Les numéros suivants existent déjà parmi vos contacts : ${duplicatePhones.join(', ')}`
      );
    }

    // Créer tous les contacts
    const contacts = createDtos.map(dto =>
      this.emergencyContactRepository.create({
        ...dto,
        userId,
      })
    );

    const saved = await this.emergencyContactRepository.save(contacts);
    return saved.map((contact) => this.sanitizeEmergencyContact(contact));
  }

  async findAllEmergencyContacts(userId: string): Promise<SanitizedEmergencyContact[]> {
    this.logger.debug(`Fetching emergency contacts for user ${userId}`);

    const contacts = await this.emergencyContactRepository.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });

    return contacts.map((contact) => this.sanitizeEmergencyContact(contact));
  }

  async updateEmergencyContact(
    userId: string,
    contactId: string,
    updateDto: UpdateEmergencyContactDto,
  ): Promise<SanitizedEmergencyContact> {
    this.logger.debug(`Updating emergency contact ${contactId} for user ${userId}`);

    const contact = await this.emergencyContactRepository.findOne({
      where: { id: contactId, userId },
    });

    if (!contact) {
      throw new NotFoundException('Contact d\'urgence non trouvé');
    }

    Object.assign(contact, updateDto);
    const updated = await this.emergencyContactRepository.save(contact);
    return this.sanitizeEmergencyContact(updated);
  }

  async deleteEmergencyContact(userId: string, contactId: string): Promise<void> {
    this.logger.debug(`Deleting emergency contact ${contactId} for user ${userId}`);

    const result = await this.emergencyContactRepository.delete({
      id: contactId,
      userId,
    });

    if (result.affected === 0) {
      throw new NotFoundException('Contact d\'urgence non trouvé');
    }
  }

  // ==================== Safety Alerts ====================

  async createSafetyAlert(userId: string, createDto: CreateSafetyAlertDto): Promise<SanitizedSafetyAlert> {
    this.logger.debug(`Creating safety alert for user ${userId}, type: ${createDto.type}`);

    // Vérifier si l'utilisateur a un trip ou booking actif
    let trip: Trip | null = null;
    let booking: Booking | null = null;

    if (createDto.tripId) {
      trip = await this.tripRepository.findOne({ where: { id: createDto.tripId } });
      if (!trip) {
        throw new NotFoundException('Trip non trouvé');
      }
    }

    if (createDto.bookingId) {
      booking = await this.bookingRepository.findOne({ where: { id: createDto.bookingId } });
      if (!booking) {
        throw new NotFoundException('Booking non trouvé');
      }
    }

    const alert = this.safetyAlertRepository.create({
      ...createDto,
      userId,
      tripId: trip?.id || null,
      bookingId: booking?.id || null,
      lastLocationUpdate: createDto.latitude && createDto.longitude ? new Date() : null,
    });

    const saved = await this.safetyAlertRepository.save(alert);

    // Notifier les contacts d'urgence
    await this.notifyEmergencyContacts(userId, saved);

    return this.sanitizeSafetyAlert(saved);
  }

  async updateLocation(userId: string, updateDto: UpdateLocationDto): Promise<void> {
    this.logger.debug(`Updating location for user ${userId}`);

    // Vérifier s'il y a une alerte active pour cet utilisateur
    const activeAlert = await this.safetyAlertRepository.findOne({
      where: {
        userId,
        status: SafetyAlertStatus.ACTIVE,
      },
      order: { createdAt: 'DESC' },
    });

    if (activeAlert) {
      // Mettre à jour la dernière mise à jour de position
      activeAlert.latitude = updateDto.latitude;
      activeAlert.longitude = updateDto.longitude;
      activeAlert.batteryLevel = updateDto.batteryLevel || activeAlert.batteryLevel;
      activeAlert.lastLocationUpdate = new Date();
      await this.safetyAlertRepository.save(activeAlert);
    }

    // Vérifier le niveau de batterie
    if (updateDto.batteryLevel !== undefined && updateDto.batteryLevel <= this.LOW_BATTERY_THRESHOLD) {
      // Vérifier s'il n'y a pas déjà une alerte de batterie faible active
      const existingBatteryAlert = await this.safetyAlertRepository.findOne({
        where: {
          userId,
          type: SafetyAlertType.LOW_BATTERY,
          status: SafetyAlertStatus.ACTIVE,
        },
      });

      if (!existingBatteryAlert) {
        await this.createSafetyAlert(userId, {
          type: SafetyAlertType.LOW_BATTERY,
          latitude: updateDto.latitude,
          longitude: updateDto.longitude,
          batteryLevel: updateDto.batteryLevel,
          tripId: updateDto.tripId,
          bookingId: updateDto.bookingId,
        });
      }
    }
  }

  async findAllSafetyAlerts(userId?: string): Promise<SanitizedSafetyAlert[]> {
    this.logger.debug(`Fetching safety alerts${userId ? ` for user ${userId}` : ''}`);

    const where = userId ? { userId } : {};
    const alerts = await this.safetyAlertRepository.find({
      where,
      relations: ['user', 'trip', 'booking'],
      order: { createdAt: 'DESC' },
    });

    return alerts.map((alert) => this.sanitizeSafetyAlert(alert));
  }

  async findOneSafetyAlert(alertId: string, userId?: string): Promise<SanitizedSafetyAlert> {
    this.logger.debug(`Fetching safety alert ${alertId}`);

    const alert = await this.safetyAlertRepository.findOne({
      where: { id: alertId },
      relations: ['user', 'trip', 'booking'],
    });

    if (!alert) {
      throw new NotFoundException('Alerte de sécurité non trouvée');
    }

    // Vérifier les permissions
    if (userId && alert.userId !== userId) {
      throw new ForbiddenException('Vous n\'avez pas accès à cette alerte');
    }

    return this.sanitizeSafetyAlert(alert);
  }

  async updateSafetyAlertStatus(
    alertId: string,
    userId: string,
    updateDto: UpdateSafetyAlertStatusDto,
  ): Promise<SanitizedSafetyAlert> {
    this.logger.debug(`Updating safety alert ${alertId} status`);

    const alert = await this.safetyAlertRepository.findOne({
      where: { id: alertId },
    });

    if (!alert) {
      throw new NotFoundException('Alerte de sécurité non trouvée');
    }

    // Seul l'utilisateur concerné ou un admin peut résoudre l'alerte
    if (alert.userId !== userId) {
      throw new ForbiddenException('Vous n\'avez pas la permission de modifier cette alerte');
    }

    alert.status =
      updateDto.status === 'resolved' ? SafetyAlertStatus.RESOLVED : SafetyAlertStatus.FALSE_ALARM;
    alert.resolvedAt = new Date();
    alert.resolvedBy = userId;

    const updated = await this.safetyAlertRepository.save(alert);
    return this.sanitizeSafetyAlert(updated);
  }

  // Job cron pour détecter les téléphones éteints brusquement
  @Cron(CronExpression.EVERY_MINUTE)
  async checkForPhoneShutdowns() {
    // Use setImmediate to ensure HTTP requests have priority
    setImmediate(async () => {
      this.logger.debug('Checking for phone shutdowns during active trips');

    // Trouver toutes les alertes actives avec une dernière mise à jour de position
    const activeAlerts = await this.safetyAlertRepository.find({
      where: {
        status: SafetyAlertStatus.ACTIVE,
        lastLocationUpdate: MoreThan(new Date(Date.now() - 24 * 60 * 60 * 1000)), // Dans les dernières 24h
      },
      relations: ['trip', 'booking'],
    });

    const now = new Date();

    for (const alert of activeAlerts) {
      // Vérifier si la dernière mise à jour est trop ancienne
      if (alert.lastLocationUpdate) {
        const timeSinceLastUpdate = now.getTime() - alert.lastLocationUpdate.getTime();

        // Si plus de 5 minutes sans mise à jour et qu'il y a un trip/booking actif
        if (timeSinceLastUpdate > this.LOCATION_UPDATE_TIMEOUT) {
          // Vérifier si le trip ou booking est toujours actif
          const isTripActive = alert.tripId
            ? await this.isTripActive(alert.tripId)
            : false;
          const isBookingActive = alert.bookingId
            ? await this.isBookingActive(alert.bookingId)
            : false;

          if (isTripActive || isBookingActive) {
            // Vérifier s'il n'y a pas déjà une alerte de type PHONE_SHUTDOWN
            const whereCondition: any = {
              userId: alert.userId,
              type: SafetyAlertType.PHONE_SHUTDOWN,
              status: SafetyAlertStatus.ACTIVE,
            };

            // Ajouter tripId et bookingId seulement s'ils ne sont pas null
            if (alert.tripId !== null) {
              whereCondition.tripId = alert.tripId;
            } else {
              whereCondition.tripId = IsNull();
            }

            if (alert.bookingId !== null) {
              whereCondition.bookingId = alert.bookingId;
            } else {
              whereCondition.bookingId = IsNull();
            }

            const existingShutdownAlert = await this.safetyAlertRepository.findOne({
              where: whereCondition,
            });

            if (!existingShutdownAlert) {
              this.logger.warn(
                `Detected potential phone shutdown for user ${alert.userId} during trip/booking`,
              );

              // Créer une alerte de téléphone éteint
              const shutdownAlert = this.safetyAlertRepository.create({
                userId: alert.userId,
                tripId: alert.tripId,
                bookingId: alert.bookingId,
                type: SafetyAlertType.PHONE_SHUTDOWN,
                status: SafetyAlertStatus.ACTIVE,
                message: 'Téléphone éteint brusquement pendant une course active',
                latitude: alert.latitude,
                longitude: alert.longitude,
                batteryLevel: alert.batteryLevel,
                lastLocationUpdate: alert.lastLocationUpdate,
              });

              const saved = await this.safetyAlertRepository.save(shutdownAlert);

              // Notifier les contacts d'urgence
              await this.notifyEmergencyContacts(alert.userId, saved);
            }
          }
        }
      }
    }
    });
  }

  private async isTripActive(tripId: string): Promise<boolean> {
    const trip = await this.tripRepository.findOne({
      where: { id: tripId },
    });

    if (!trip) {
      return false;
    }

    // Un trip est actif si la date de départ est passée et le trip n'est pas encore complété
    const now = new Date();
    return (
      trip.departureDate <= now &&
      trip.status === TripStatus.ACTIVE &&
      !trip.completedAt
    );
  }

  private async isBookingActive(bookingId: string): Promise<boolean> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['trip'],
    });

    if (!booking || !booking.trip) {
      return false;
    }

    // Un booking est actif si le trip est actif et le booking est accepté
    const now = new Date();
    return (
      booking.status === BookingStatus.ACCEPTED &&
      booking.trip.departureDate <= now &&
      booking.trip.status === TripStatus.ACTIVE &&
      !booking.trip.completedAt
    );
  }

  // ==================== User Reports ====================

  async createUserReport(userId: string, createDto: CreateUserReportDto): Promise<SanitizedUserReport> {
    this.logger.debug(`Creating user report from ${userId} against ${createDto.reportedUserId}`);

    // Vérifier que l'utilisateur ne se signale pas lui-même
    if (userId === createDto.reportedUserId) {
      throw new BadRequestException('Vous ne pouvez pas vous signaler vous-même');
    }

    // Vérifier que l'utilisateur signalé existe
    const reportedUser = await this.userRepository.findOne({
      where: { id: createDto.reportedUserId },
    });

    if (!reportedUser) {
      throw new NotFoundException('Utilisateur signalé non trouvé');
    }

    // Vérifier les trips/bookings si fournis
    if (createDto.tripId) {
      const trip = await this.tripRepository.findOne({ where: { id: createDto.tripId } });
      if (!trip) {
        throw new NotFoundException('Trip non trouvé');
      }
    }

    if (createDto.bookingId) {
      const booking = await this.bookingRepository.findOne({ where: { id: createDto.bookingId } });
      if (!booking) {
        throw new NotFoundException('Booking non trouvé');
      }
    }

    const report = this.userReportRepository.create({
      ...createDto,
      reporterId: userId,
    });

    const saved = await this.userReportRepository.save(report);

    // TODO: Notifier les admins du signalement

    return this.sanitizeUserReport(saved);
  }

  async findAllUserReports(userId?: string): Promise<SanitizedUserReport[]> {
    this.logger.debug(`Fetching user reports${userId ? ` for user ${userId}` : ''}`);

    const where = userId ? { reporterId: userId } : {};
    const reports = await this.userReportRepository.find({
      where,
      relations: ['reporter', 'reportedUser', 'trip', 'booking'],
      order: { createdAt: 'DESC' },
    });

    return reports.map((report) => this.sanitizeUserReport(report));
  }

  async findOneUserReport(reportId: string, userId?: string): Promise<SanitizedUserReport> {
    this.logger.debug(`Fetching user report ${reportId}`);

    const report = await this.userReportRepository.findOne({
      where: { id: reportId },
      relations: ['reporter', 'reportedUser', 'trip', 'booking'],
    });

    if (!report) {
      throw new NotFoundException('Signalement non trouvé');
    }

    // Vérifier les permissions (seul le reporter ou un admin peut voir le signalement)
    if (userId && report.reporterId !== userId) {
      throw new ForbiddenException('Vous n\'avez pas accès à ce signalement');
    }

    return this.sanitizeUserReport(report);
  }

  async updateReportStatus(
    reportId: string,
    adminId: string,
    updateDto: UpdateReportStatusDto,
  ): Promise<SanitizedUserReport> {
    this.logger.debug(`Updating user report ${reportId} status`);

    // Vérifier que l'utilisateur est un admin
    const admin = await this.userRepository.findOne({
      where: { id: adminId },
    });

    if (!admin || admin.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Seuls les administrateurs peuvent modifier le statut d\'un signalement');
    }

    const report = await this.userReportRepository.findOne({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('Signalement non trouvé');
    }

    report.status =
      updateDto.status === 'under_review'
        ? ReportStatus.UNDER_REVIEW
        : updateDto.status === 'resolved'
          ? ReportStatus.RESOLVED
          : ReportStatus.DISMISSED;
    report.reviewedAt = new Date();
    report.reviewedBy = adminId;
    report.adminNotes = updateDto.adminNotes || null;

    const updated = await this.userReportRepository.save(report);
    return this.sanitizeUserReport(updated);
  }

  // ==================== Helper Methods ====================

  private async notifyEmergencyContacts(userId: string, alert: SafetyAlert): Promise<void> {
    try {
      const contacts = await this.emergencyContactRepository.find({
        where: { userId, isActive: true },
      });

      if (contacts.length === 0) {
        this.logger.debug(`No emergency contacts found for user ${userId}`);
        return;
      }

      const user = await this.userRepository.findOne({ where: { id: userId } });
      const userName = user ? `${user.firstName} ${user.lastName}` : 'Un utilisateur';

      const alertMessages = {
        [SafetyAlertType.PHONE_SHUTDOWN]: 'Téléphone éteint brusquement pendant une course',
        [SafetyAlertType.LOW_BATTERY]: 'Batterie faible détectée',
        [SafetyAlertType.MANUAL_ALERT]: 'Alerte manuelle déclenchée',
        [SafetyAlertType.EMERGENCY]: 'Urgence déclarée',
        [SafetyAlertType.NO_RESPONSE]: 'Pas de réponse',
      };

      const message = alertMessages[alert.type] || 'Alerte de sécurité';

      // TODO: Envoyer des SMS ou appels aux contacts d'urgence
      // Pour l'instant, on log juste
      this.logger.warn(
        `Safety alert for user ${userId}: ${message}. Emergency contacts: ${contacts.map((c) => c.phone).join(', ')}`,
      );

      // Notifier l'utilisateur aussi si il a un FCM token
      if (user?.fcmToken) {
        await this.notificationService.sendNotification(
          user.fcmToken,
          'Alerte de sécurité',
          message,
          {
            alertId: alert.id,
            type: alert.type,
            latitude: alert.latitude?.toString() || '',
            longitude: alert.longitude?.toString() || '',
          },
          userId,
        );
      }
    } catch (error) {
      this.logger.error(`Error notifying emergency contacts: ${error.message}`, error.stack);
    }
  }

  private sanitizeEmergencyContact(contact: EmergencyContact): SanitizedEmergencyContact {
    return {
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      relationship: contact.relationship,
      isActive: contact.isActive,
      createdAt: contact.createdAt,
    };
  }

  private sanitizeSafetyAlert(alert: SafetyAlert): SanitizedSafetyAlert {
    return {
      id: alert.id,
      userId: alert.userId,
      tripId: alert.tripId,
      bookingId: alert.bookingId,
      type: alert.type,
      status: alert.status,
      message: alert.message,
      latitude: alert.latitude ? Number(alert.latitude) : null,
      longitude: alert.longitude ? Number(alert.longitude) : null,
      batteryLevel: alert.batteryLevel ? Number(alert.batteryLevel) : null,
      lastLocationUpdate: alert.lastLocationUpdate,
      createdAt: alert.createdAt,
      resolvedAt: alert.resolvedAt,
    };
  }

  private sanitizeUserReport(report: UserReport): SanitizedUserReport {
    return {
      id: report.id,
      reporterId: report.reporterId,
      reportedUserId: report.reportedUserId,
      reason: report.reason,
      description: report.description,
      status: report.status,
      tripId: report.tripId,
      bookingId: report.bookingId,
      createdAt: report.createdAt,
      reviewedAt: report.reviewedAt,
    };
  }
}

