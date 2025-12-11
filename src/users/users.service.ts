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
import { DataSource } from 'typeorm';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<any>,
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(Message)
    private messageRepository: Repository<Message>,
    private fileUploadService: FileUploadService,
    private kycValidationService: KycValidationService,
    private readonly dataSource: DataSource,
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

    // 1. User Existence Check (Fail Fast)
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found.`);
    }

    // 2. Existing KYC Check Logic (Allow RETRY if REJECTED)
    const existingKyc = await this.kycDocumentRepository.findOne({ where: { userId } });

    if (existingKyc) {
      if (existingKyc.status === KycStatus.APPROVED) {
        throw new BadRequestException('Your KYC document has already been approved.');
      }
      if (existingKyc.status === KycStatus.PENDING) {
        throw new BadRequestException('You already have a KYC document pending verification. Please wait.');
      }
      // If REJECTED, we continue: the new document will replace/update the old one
    }

    // 3. File Presence Check
    const cniFrontFile = files?.cniFront?.[0];
    const cniBackFile = files?.cniBack?.[0];
    const selfieFile = files?.selfie?.[0];

    if (!cniFrontFile || !cniBackFile || !selfieFile) {
      throw new BadRequestException('All KYC images are required');
    }

    // 4. S3 File Upload (External execution, before the transaction starts)
    const [cniFrontUrl, cniBackUrl, selfieUrl] = await Promise.all([
      this.fileUploadService.saveFile(cniFrontFile, 'kyc'),
      this.fileUploadService.saveFile(cniBackFile, 'kyc'),
      this.fileUploadService.saveFile(selfieFile, 'kyc'),
    ]);

    // 5. KYC Validation (with error handling)
    let kycStatus = KycStatus.PENDING;
    let rejectionReason: string | null = null;
    let isApprovalConfirmed = false;

    try {
      this.logger.debug(`Validating KYC for user: ${userId}`);
      const validationResult = await this.kycValidationService.validateKyc(
        cniFrontFile.buffer,
        selfieFile.buffer,
      );

      if (validationResult.isValid) {
        kycStatus = KycStatus.APPROVED;
        isApprovalConfirmed = true;
        this.logger.log(`KYC validation successful for user: ${userId}`);
      } else {
        kycStatus = KycStatus.REJECTED;
        rejectionReason = validationResult.reason || 'KYC Validation Failed';
        this.logger.warn(`KYC validation failed for user: ${userId} - Reason: ${rejectionReason}`);
      }
    } catch (error) {
      this.logger.error(`KYC validation error for user: ${userId}: ${error.message}`);
      // In case of an AI service error, status remains PENDING for manual review
      kycStatus = KycStatus.PENDING;
      this.logger.warn(`KYC validation service error, keeping status as PENDING`);
    }

    // 6. Start Database Transaction (Atomicity)
    // This is crucial to link the KYC save and the user status update.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();


    try {
      // Prepare the KYC document (TypeORM FIX: Pass the 'user' object)
      let kycDocument = existingKyc
        ? this.kycDocumentRepository.merge(existingKyc, {})
        : this.kycDocumentRepository.create({
          userId, // <-- TypeORM BUG FIX: Pass the user object
          cniFrontUrl,
          cniBackUrl,
          selfieUrl,
          status: kycStatus,
          rejectionReason,
          documentNumber: uploadKycDto.documentNumber,
        });

      kycDocument = queryRunner.manager.merge(KycDocument, kycDocument, {
        user: user, // <-- TypeORM BUG FIX: Pass the user object
        cniFrontUrl,
        cniBackUrl,
        selfieUrl,
        status: kycStatus,
        rejectionReason,
        documentNumber: uploadKycDto.documentNumber,
      } as DeepPartial<KycDocument>);

      const savedKyc = await queryRunner.manager.save(kycDocument);

      // Update user status ONLY if approval is confirmed
      if (isApprovalConfirmed) {
        user.status = UserStatus.ACTIVE;
        await queryRunner.manager.save(user); // Transactional user save
        this.logger.log(`User ${userId} status updated to ACTIVE after KYC approval`);
      }

      await queryRunner.commitTransaction();

      this.logger.log(`KYC documents uploaded successfully for user: ${userId} (Status: ${kycStatus})`);

      // Convert S3 keys to presigned URLs
      return await this.enrichKycWithPresignedUrls(savedKyc);

    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Transaction failed for user ${userId}`, error.stack);

      // 7. NEW: S3 File Cleanup Process 🗑️
      try {
        this.logger.warn(`Transaction failed. Starting cleanup for S3 files for user: ${userId}`);

        // Parallel deletion of all uploaded files
        await Promise.all([
          this.fileUploadService.deleteFile(cniFrontUrl),
          this.fileUploadService.deleteFile(cniBackUrl),
          this.fileUploadService.deleteFile(selfieUrl),
        ]);

        this.logger.log(`S3 files cleaned up successfully for user: ${userId}`);
      } catch (cleanupError) {
        // If cleanup fails, we log the error but still throw the original transaction error.
        this.logger.error(
          `FATAL: Failed to clean up S3 files after transaction rollback. Orphaned files remaining.`,
          cleanupError.stack
        );
      }

      throw error; // Throw the original transaction error
    } finally {
      await queryRunner.release();
    }
  }


  async getKycStatus(userId: string): Promise<KycDocument | null> {
    const kyc = await this.kycDocumentRepository.findOneBy({
      userId: userId
    });

    this.logger.log(`Fetching KYC status for user: ${kyc} ${userId}`);
    console.log("kyc", kyc);

    if (!kyc) {
      return null;
    }

    const thisUserKyc = await this.enrichKycWithPresignedUrls(kyc);

    console.log("thiskyc", thisUserKyc);

    // Convert S3 keys to presigned URLs before returning
    return thisUserKyc
  }

  async updateFcmToken(userId: string, fcmToken: string): Promise<void> {
    this.logger.debug(`Updating FCM token for user: ${userId}`);

    const user = await this.findOne(userId);
    user.fcmToken = fcmToken;
    await this.userRepository.save(user);

    this.logger.debug(`FCM token updated for user: ${userId}`);
  }
}

