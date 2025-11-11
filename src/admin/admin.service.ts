import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus, UserRole } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { Trip } from '../trips/entities/trip.entity';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
  ) {}

  async verifyKyc(kycId: string, adminId: string, approved: boolean, reason?: string): Promise<KycDocument> {
    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can verify KYC');
    }

    const kycDocument = await this.kycDocumentRepository.findOne({
      where: { id: kycId },
      relations: ['user'],
    });

    if (!kycDocument) {
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
    } else {
      kycDocument.user.status = UserStatus.PENDING_KYC;
      await this.userRepository.save(kycDocument.user);
    }

    return await this.kycDocumentRepository.save(kycDocument);
  }

  async getPendingKycs(): Promise<KycDocument[]> {
    return this.kycDocumentRepository.find({
      where: { status: KycStatus.PENDING },
      relations: ['user'],
      order: { createdAt: 'ASC' },
    });
  }

  async getAllUsers(page: number = 1, limit: number = 10): Promise<{ users: User[]; total: number }> {
    const [users, total] = await this.userRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { users, total };
  }

  async suspendUser(userId: string, adminId: string): Promise<User> {
    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can suspend users');
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.status = UserStatus.SUSPENDED;
    return await this.userRepository.save(user);
  }

  async activateUser(userId: string, adminId: string): Promise<User> {
    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can activate users');
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.status = UserStatus.ACTIVE;
    return await this.userRepository.save(user);
  }

  async getAllTrips(page: number = 1, limit: number = 10): Promise<{ trips: Trip[]; total: number }> {
    const [trips, total] = await this.tripRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      relations: ['driver'],
      order: { createdAt: 'DESC' },
    });

    return { trips, total };
  }
}

