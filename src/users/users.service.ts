import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';
import { User, UserStatus } from './entities/user.entity';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';
import { UpdateProfileDto, UploadKycDto } from './dto/user.dto';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Message } from '../chat/entities/message.entity';
import { FileUploadService } from '../common/services/file-upload.service';
import { Express } from 'express';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(Message)
    private messageRepository: Repository<Message>,
    private fileUploadService: FileUploadService,
  ) {}

  private toSafeUser(user: User) {
    const { password, refreshToken, ...safeUser } = user;
    return safeUser;
  }

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

  async getProfileSummary(userId: string) {
    const user = await this.findOne(userId);

    const [
      tripsAsDriver,
      bookingsAsPassenger,
      bookingsAsDriver,
      messagesSent,
    ] = await Promise.all([
      this.tripRepository.count({ where: { driverId: userId } }),
      this.bookingRepository.count({ where: { passengerId: userId } }),
      this.bookingRepository
        .createQueryBuilder('booking')
        .innerJoin('booking.trip', 'trip')
        .where('trip.driverId = :userId', { userId })
        .getCount(),
      this.messageRepository.count({ where: { senderId: userId } }),
    ]);

    return {
      user: this.toSafeUser(user),
      stats: {
        vehicles: user.vehicles?.length ?? 0,
        tripsAsDriver,
        bookingsAsPassenger,
        bookingsAsDriver,
        messagesSent,
      },
    };
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

    const previousProfilePicture = user.profilePicture;

    if (updateProfileDto.firstName !== undefined) {
      user.firstName = updateProfileDto.firstName;
    }

    if (updateProfileDto.lastName !== undefined) {
      user.lastName = updateProfileDto.lastName;
    }

    if (updateProfileDto.profilePicture !== undefined) {
      user.profilePicture = updateProfileDto.profilePicture;
    }

    if (updateProfileDto.wantsToBeDriver !== undefined) {
      user.isDriver = updateProfileDto.wantsToBeDriver;
    }

    if (updateProfileDto.phone) {
      user.phone = updateProfileDto.phone;
    }

    const updatedUser = await this.userRepository.save(user);

    if (
      updateProfileDto.profilePicture &&
      previousProfilePicture &&
      updateProfileDto.profilePicture !== previousProfilePicture
    ) {
      await this.fileUploadService.deleteFile(previousProfilePicture);
    }

    this.logger.log(`Profile updated successfully for user: ${userId}`);
    return updatedUser;
  }

  async uploadKyc(
    userId: string,
    uploadKycDto: UploadKycDto,
    files?: {
      cniFront?: Express.Multer.File[];
      cniBack?: Express.Multer.File[];
      selfie?: Express.Multer.File[];
    },
  ): Promise<KycDocument> {
    this.logger.log(`Uploading KYC documents for user: ${userId}`);
    
    const user = await this.findOne(userId);

    // Check if user already has a pending KYC
    const existingKyc = await this.kycDocumentRepository.findOne({
      where: { userId },
    });

    // if (existingKyc) {
    //   this.logger.warn(`KYC upload failed: User ${userId} already has pending KYC`);
    //   throw new BadRequestException('You already have a pending KYC verification');
    // }

    const cniFrontFile = files?.cniFront?.[0];
    const cniBackFile = files?.cniBack?.[0];
    const selfieFile = files?.selfie?.[0];

    if (!cniFrontFile || !cniBackFile || !selfieFile) {
      throw new BadRequestException('All KYC images are required');
    }

    const [cniFrontUrl, cniBackUrl, selfieUrl] = await Promise.all([
      this.fileUploadService.saveFile(cniFrontFile, 'kyc'),
      this.fileUploadService.saveFile(cniBackFile, 'kyc'),
      this.fileUploadService.saveFile(selfieFile, 'kyc'),
    ]);

    const kycDocument = this.kycDocumentRepository.create({
      userId,
      cniFrontUrl,
      cniBackUrl,
      selfieUrl,
      status: KycStatus.PENDING,
      documentNumber: uploadKycDto.documentNumber,
    } as DeepPartial<KycDocument>);

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

