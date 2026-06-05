import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus, UserRole } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { Trip } from '../trips/entities/trip.entity';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
  ) {}

  async verifyKyc(
    kycId: string,
    adminId: string,
    approved: boolean,
    reason?: string,
  ): Promise<KycDocument> {
    this.logger.log(
      `Admin ${adminId} verifying KYC ${kycId} - Approved: ${approved}`,
    );

    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      this.logger.warn(
        `KYC verification failed: User ${adminId} is not an admin`,
      );
      throw new ForbiddenException('Only admins can verify KYC');
    }

    const kycDocument = await this.kycDocumentRepository.findOne({
      where: { id: kycId },
      relations: ['user'],
    });

    if (!kycDocument) {
      this.logger.warn(
        `KYC verification failed: KYC document ${kycId} not found`,
      );
      throw new NotFoundException('KYC document not found');
    }

    kycDocument.status = approved ? KycStatus.APPROVED : KycStatus.REJECTED;
    kycDocument.reviewedBy = adminId;
    kycDocument.reviewedAt = new Date();
    if (reason) {
      kycDocument.rejectionReason = reason;
    }

    // Update user status
    if (approved) {
      kycDocument.user.status = UserStatus.ACTIVE;
      await this.userRepository.save(kycDocument.user);
      this.logger.log(
        `KYC ${kycId} approved - User ${kycDocument.user.id} status set to ACTIVE`,
      );
    } else {
      kycDocument.user.status = UserStatus.PENDING_KYC;
      await this.userRepository.save(kycDocument.user);
      this.logger.log(
        `KYC ${kycId} rejected - User ${kycDocument.user.id} status set to PENDING_KYC. Reason: ${reason || 'N/A'}`,
      );
    }

    const savedKyc = await this.kycDocumentRepository.save(kycDocument);
    return savedKyc;
  }

  async getPendingKycs(): Promise<KycDocument[]> {
    this.logger.debug('Fetching pending KYC documents');

    const pendingKycs = await this.kycDocumentRepository.find({
      where: { status: KycStatus.PENDING },
      relations: ['user'],
      order: { createdAt: 'ASC' },
    });

    this.logger.debug(`Found ${pendingKycs.length} pending KYC documents`);
    return pendingKycs;
  }

  async getAllUsers(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ users: User[]; total: number }> {
    this.logger.debug(`Fetching all users - Page: ${page}, Limit: ${limit}`);

    const [users, total] = await this.userRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    this.logger.debug(`Fetched ${users.length} users (total: ${total})`);
    return { users, total };
  }

  async suspendUser(userId: string, adminId: string): Promise<User> {
    this.logger.warn(`Admin ${adminId} suspending user ${userId}`);

    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      this.logger.warn(
        `User suspension failed: User ${adminId} is not an admin`,
      );
      throw new ForbiddenException('Only admins can suspend users');
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`User suspension failed: User ${userId} not found`);
      throw new NotFoundException('User not found');
    }

    user.status = UserStatus.SUSPENDED;
    user.isActive = false;
    user.accessToken = null;
    user.refreshToken = null;
    user.fcmToken = null;
    const suspendedUser = await this.userRepository.save(user);

    this.logger.warn(`User ${userId} suspended by admin ${adminId}`);
    return suspendedUser;
  }

  async activateUser(userId: string, adminId: string): Promise<User> {
    this.logger.log(`Admin ${adminId} activating user ${userId}`);

    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      this.logger.warn(
        `User activation failed: User ${adminId} is not an admin`,
      );
      throw new ForbiddenException('Only admins can activate users');
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`User activation failed: User ${userId} not found`);
      throw new NotFoundException('User not found');
    }

    user.status = UserStatus.ACTIVE;
    user.isActive = true;
    const activatedUser = await this.userRepository.save(user);

    this.logger.log(`User ${userId} activated by admin ${adminId}`);
    return activatedUser;
  }

  async getAllTrips(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ trips: Trip[]; total: number }> {
    this.logger.debug(`Fetching all trips - Page: ${page}, Limit: ${limit}`);

    const [trips, total] = await this.tripRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      relations: ['driver'],
      order: { createdAt: 'DESC' },
    });

    this.logger.debug(`Fetched ${trips.length} trips (total: ${total})`);
    return { trips, total };
  }
}
