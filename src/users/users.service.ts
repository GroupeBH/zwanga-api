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
import { KycValidationService } from '../common/services/kyc-validation.service';
import { Express } from 'express';
import { UserRole } from './entities/user.entity';

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
    private kycValidationService: KycValidationService,
  ) { }

  private toSafeUser(user: User) {
    const { password, refreshToken, ...safeUser } = user;
    return safeUser;
  }

  /**
   * Convert S3 keys to presigned URLs for user profile picture
   */
  private async enrichUserWithPresignedUrls(user: User): Promise<User> {
    if (user.profilePicture) {
      user.profilePicture = await this.fileUploadService.getPresignedUrlIfS3Key(user.profilePicture) || user.profilePicture;
    }
    return user;
  }

  /**
   * Convert S3 keys to presigned URLs for KYC documents
   */
  private async enrichKycWithPresignedUrls(kyc: KycDocument): Promise<KycDocument> {
    if (kyc.cniFrontUrl) {
      kyc.cniFrontUrl = await this.fileUploadService.getPresignedUrlIfS3Key(kyc.cniFrontUrl) || kyc.cniFrontUrl;
    }
    if (kyc.cniBackUrl) {
      kyc.cniBackUrl = await this.fileUploadService.getPresignedUrlIfS3Key(kyc.cniBackUrl) || kyc.cniBackUrl;
    }
    if (kyc.selfieUrl) {
      kyc.selfieUrl = await this.fileUploadService.getPresignedUrlIfS3Key(kyc.selfieUrl) || kyc.selfieUrl;
    }
    return kyc;
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

    // Convert S3 keys to presigned URLs
    const enrichedUser = await this.enrichUserWithPresignedUrls(user);

    return {
      user: this.toSafeUser(enrichedUser),
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

  async updateProfile(
    userId: string,
    updateProfileDto: UpdateProfileDto,
    profilePictureFile?: Express.Multer.File,
  ): Promise<User> {
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

    if (profilePictureFile) {
      const uploadedUrl = await this.fileUploadService.saveFile(
        profilePictureFile,
        'profiles',
      );

      if (uploadedUrl) {
        user.profilePicture = uploadedUrl;
      }
    }

    if (updateProfileDto.role) {
      user.role = updateProfileDto.role;
    }

    if (updateProfileDto.phone) {
      user.phone = updateProfileDto.phone;
    }

    const updatedUser = await this.userRepository.save(user);

    if (
      profilePictureFile &&
      previousProfilePicture &&
      previousProfilePicture !== updatedUser.profilePicture
    ) {
      await this.fileUploadService.deleteFile(previousProfilePicture);
    }

    this.logger.log(`Profile updated successfully for user: ${userId}`);

    // Convert S3 key to presigned URL before returning
    return await this.enrichUserWithPresignedUrls(updatedUser);
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

    // Check if user already has a KYC in progress
    const existingKyc = await this.kycDocumentRepository.findOne({
      where: { userId },
    });

    if (existingKyc) {
      this.logger.warn(`KYC upload failed: User ${userId} already has a KYC document in progress (Status: ${existingKyc.status})`);
      
      // Determine the appropriate message based on KYC status
      let message = 'Vous avez déjà un document KYC en cours de vérification.';
      if (existingKyc.status === KycStatus.APPROVED) {
        message = 'Votre document KYC a déjà été approuvé.';
      } else if (existingKyc.status === KycStatus.REJECTED) {
        message = 'Votre document KYC a été rejeté. Veuillez contacter le support pour plus d\'informations.';
        if (existingKyc.rejectionReason) {
          message += ` Raison: ${existingKyc.rejectionReason}`;
        }
      } else if (existingKyc.status === KycStatus.PENDING) {
        message = 'Vous avez déjà un document KYC en attente de vérification. Veuillez patienter.';
      }
      
      throw new BadRequestException(message);
    }

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

    // Validate KYC using AWS Rekognition
    let validationResult;
    let kycStatus = KycStatus.PENDING;
    let rejectionReason: string | null = null;

    try {
      this.logger.debug(`Validating KYC for user: ${userId}`);
      validationResult = await this.kycValidationService.validateKyc(
        cniFrontFile.buffer,
        selfieFile.buffer,
      );

      if (validationResult.isValid) {
        kycStatus = KycStatus.APPROVED;
        this.logger.log(
          `KYC validation successful for user: ${userId} - Similarity: ${validationResult.faceMatch.similarity.toFixed(1)}%`,
        );
      } else {
        kycStatus = KycStatus.REJECTED;
        rejectionReason = validationResult.reason || 'Validation KYC échouée';
        this.logger.warn(
          `KYC validation failed for user: ${userId} - Reason: ${rejectionReason}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `KYC validation error for user: ${userId}:`,
        error.message,
      );
      // If validation fails due to service error, keep status as PENDING for manual review
      kycStatus = KycStatus.PENDING;
      this.logger.warn(
        `KYC validation service error, keeping status as PENDING for manual review`,
      );
    }

    const kycDocument = this.kycDocumentRepository.create({
      userId,
      cniFrontUrl,
      cniBackUrl,
      selfieUrl,
      status: kycStatus,
      rejectionReason,
      documentNumber: uploadKycDto.documentNumber,
    } as DeepPartial<KycDocument>);

    const savedKyc = await this.kycDocumentRepository.save(kycDocument);

    // Update user status if KYC is approved
    if (kycStatus === KycStatus.APPROVED) {
      user.status = UserStatus.ACTIVE;
      await this.userRepository.save(user);
      this.logger.log(
        `User ${userId} status updated to ACTIVE after KYC approval`,
      );
    }

    this.logger.log(
      `KYC documents uploaded successfully for user: ${userId} (KYC ID: ${savedKyc.id}, Status: ${kycStatus})`,
    );

    // Convert S3 keys to presigned URLs before returning
    return await this.enrichKycWithPresignedUrls(savedKyc);
  }

  async getKycStatus(userId: string): Promise<KycDocument | null> {
    const kyc = await this.kycDocumentRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    if (!kyc) {
      return null;
    }

    // Convert S3 keys to presigned URLs before returning
    return await this.enrichKycWithPresignedUrls(kyc);
  }

  async updateFcmToken(userId: string, fcmToken: string): Promise<void> {
    this.logger.debug(`Updating FCM token for user: ${userId}`);

    const user = await this.findOne(userId);
    user.fcmToken = fcmToken;
    await this.userRepository.save(user);

    this.logger.debug(`FCM token updated for user: ${userId}`);
  }
}

