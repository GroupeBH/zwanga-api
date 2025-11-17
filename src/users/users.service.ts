import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus } from './entities/user.entity';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';
import { UpdateProfileDto, UploadKycDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
  ) {}

  async findOne(id: string): Promise<User> {
    this.logger.debug(`Fetching user: ${id}`);
    
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['vehicles', 'kycDocuments'],
    });

    if (!user) {
      this.logger.warn(`User not found: ${id}`);
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { email } });
  }

  async updateProfile(userId: string, updateProfileDto: UpdateProfileDto): Promise<User> {
    this.logger.log(`Updating profile for user: ${userId}`);
    
    const user = await this.findOne(userId);

    if (updateProfileDto.phone && updateProfileDto.phone !== user.phone) {
      const existingUser = await this.userRepository.findOne({
        where: { phone: updateProfileDto.phone },
      });

      if (existingUser) {
        this.logger.warn(`Profile update failed: Phone ${updateProfileDto.phone} already exists`);
        throw new BadRequestException('Phone number already exists');
      }
    }

    Object.assign(user, updateProfileDto);
    const updatedUser = await this.userRepository.save(user);
    
    this.logger.log(`Profile updated successfully for user: ${userId}`);
    return updatedUser;
  }

  async uploadKyc(userId: string, uploadKycDto: UploadKycDto): Promise<KycDocument> {
    this.logger.log(`Uploading KYC documents for user: ${userId}`);
    
    const user = await this.findOne(userId);

    // Check if user already has a pending KYC
    const existingKyc = await this.kycDocumentRepository.findOne({
      where: { userId, status: KycStatus.PENDING },
    });

    if (existingKyc) {
      this.logger.warn(`KYC upload failed: User ${userId} already has pending KYC`);
      throw new BadRequestException('You already have a pending KYC verification');
    }

    const kycDocument = this.kycDocumentRepository.create({
      userId,
      ...uploadKycDto,
      status: KycStatus.PENDING,
    });

    const savedKyc = await this.kycDocumentRepository.save(kycDocument);
    
    this.logger.log(`KYC documents uploaded successfully for user: ${userId} (KYC ID: ${savedKyc.id})`);
    return savedKyc;
  }

  async getKycStatus(userId: string): Promise<KycDocument | null> {
    return this.kycDocumentRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async updateFcmToken(userId: string, fcmToken: string): Promise<void> {
    this.logger.debug(`Updating FCM token for user: ${userId}`);
    
    const user = await this.findOne(userId);
    user.fcmToken = fcmToken;
    await this.userRepository.save(user);
    
    this.logger.debug(`FCM token updated for user: ${userId}`);
  }
}

