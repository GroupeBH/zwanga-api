import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus } from './entities/user.entity';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';
import { UpdateProfileDto, UploadKycDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
  ) {}

  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['vehicles', 'kycDocuments'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { email } });
  }

  async updateProfile(userId: string, updateProfileDto: UpdateProfileDto): Promise<User> {
    const user = await this.findOne(userId);

    if (updateProfileDto.phone && updateProfileDto.phone !== user.phone) {
      const existingUser = await this.userRepository.findOne({
        where: { phone: updateProfileDto.phone },
      });

      if (existingUser) {
        throw new BadRequestException('Phone number already exists');
      }
    }

    Object.assign(user, updateProfileDto);
    return await this.userRepository.save(user);
  }

  async uploadKyc(userId: string, uploadKycDto: UploadKycDto): Promise<KycDocument> {
    const user = await this.findOne(userId);

    // Check if user already has a pending KYC
    const existingKyc = await this.kycDocumentRepository.findOne({
      where: { userId, status: KycStatus.PENDING },
    });

    if (existingKyc) {
      throw new BadRequestException('You already have a pending KYC verification');
    }

    const kycDocument = this.kycDocumentRepository.create({
      userId,
      ...uploadKycDto,
      status: KycStatus.PENDING,
    });

    return await this.kycDocumentRepository.save(kycDocument);
  }

  async getKycStatus(userId: string): Promise<KycDocument | null> {
    return this.kycDocumentRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async updateFcmToken(userId: string, fcmToken: string): Promise<void> {
    const user = await this.findOne(userId);
    user.fcmToken = fcmToken;
    await this.userRepository.save(user);
  }
}

