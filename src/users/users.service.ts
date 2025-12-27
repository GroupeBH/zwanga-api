import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial, Not } from 'typeorm';
import type { Point } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { User, UserStatus } from './entities/user.entity';
import { KycDocument, KycStatus } from './entities/kyc-document.entity';
import { FavoriteLocation, FavoriteLocationType } from './entities/favorite-location.entity';
import { UpdateProfileDto, UploadKycDto, SendPhoneVerificationOtpDto, VerifyPhoneOtpDto, PhoneVerificationContext } from './dto/user.dto';
import { CreateFavoriteLocationDto, UpdateFavoriteLocationDto, FavoriteLocationResponse } from './dto/favorite-location.dto';
import { Trip } from '../trips/entities/trip.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Message } from '../chat/entities/message.entity';
import { FileUploadService } from '../common/services/file-upload.service';
import { KycValidationService } from '../common/services/kyc-validation.service';
import { KeccelOtpService } from '../keccel-otp/keccel-otp.service';
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
    @InjectRepository(FavoriteLocation)
    private favoriteLocationRepository: Repository<FavoriteLocation>,
    private fileUploadService: FileUploadService,
    private kycValidationService: KycValidationService,
    private keccelOtpService: KeccelOtpService,
    private readonly dataSource: DataSource,
    private configService: ConfigService,
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
    // Handle array of CNI front URLs
    if (kyc.cniFrontUrls && Array.isArray(kyc.cniFrontUrls)) {
      kyc.cniFrontUrls = await Promise.all(
        kyc.cniFrontUrls.map(url => 
          this.fileUploadService.getPresignedUrlIfS3Key(url).then(presigned => presigned || url)
        )
      );
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
        throw new BadRequestException(
          'ÉCHEC : Votre document KYC a déjà été approuvé. Vous ne pouvez pas soumettre un nouveau document KYC.'
        );
      }
      if (existingKyc.status === KycStatus.PENDING) {
        throw new BadRequestException(
          'ÉCHEC : Vous avez déjà un document KYC en attente de vérification. Veuillez patienter pendant que nous examinons votre demande.'
        );
      }
      // If REJECTED, we continue: the new document will replace/update the old one
      this.logger.log(`[KYC Upload] Previous KYC was REJECTED, allowing new submission`);
    }

    // 3. File Presence Check
    const cniFrontFiles = files?.cniFront || [];
    const cniBackFile = files?.cniBack?.[0];
    const selfieFile = files?.selfie?.[0];

    if (cniFrontFiles.length === 0 || cniFrontFiles.length > 2) {
      throw new BadRequestException(
        `ÉCHEC : Nombre de photos CNI invalide. Veuillez fournir 1 ou 2 photos du recto de votre carte d'identité (${cniFrontFiles.length} fourni${cniFrontFiles.length > 1 ? 'es' : 'e'}).`
      );
    }

    if (!cniBackFile || !selfieFile) {
      const missingFiles: string[] = [];
      if (!cniBackFile) missingFiles.push('cniBack (verso de la CNI)');
      if (!selfieFile) missingFiles.push('selfie (photo selfie)');
      
      throw new BadRequestException(
        `ÉCHEC : Fichiers manquants. Veuillez fournir tous les documents requis.\n\nFichiers manquants : ${missingFiles.join(', ')}\n\nTous les fichiers suivants sont requis :\n- cniFront : 1 ou 2 photos du recto de votre carte d'identité\n- cniBack : Photo du verso de votre carte d'identité\n- selfie : Photo selfie de vous-même`
      );
    }

    // 4. S3 File Upload (External execution, before the transaction starts)
    const cniFrontUrls = await Promise.all(
      cniFrontFiles.map(file => this.fileUploadService.saveFile(file, 'kyc'))
    );
    const [cniBackUrl, selfieUrl] = await Promise.all([
      this.fileUploadService.saveFile(cniBackFile, 'kyc'),
      this.fileUploadService.saveFile(selfieFile, 'kyc'),
    ]);
    
    // Keep first CNI front URL for backward compatibility
    const cniFrontUrl = cniFrontUrls[0];

    // 5. KYC Validation (with error handling)
    let kycStatus = KycStatus.PENDING;
    let rejectionReason: string | null = null;
    let isApprovalConfirmed = false;

    // Only perform KYC validation if AWS Rekognition is enabled
    const kycValidationEnabled = this.configService.get<string>('AWS_REKOGNITION_KYC_ENABLED') === 'true';
    
    this.logger.log(`[KYC Upload] ========================================`);
    this.logger.log(`[KYC Upload] Processing KYC upload for user: ${userId}`);
    this.logger.log(`[KYC Upload] KYC validation enabled: ${kycValidationEnabled}`);
    this.logger.log(`[KYC Upload] CNI front files: ${cniFrontFiles.length} photo(s)`);
    cniFrontFiles.forEach((file, idx) => {
      this.logger.log(`[KYC Upload]   - CNI front ${idx + 1}: ${file.originalname} (${file.size} bytes)`);
    });
    this.logger.log(`[KYC Upload] Selfie file: ${selfieFile.originalname} (${selfieFile.size} bytes)`);
    
    if (kycValidationEnabled) {
      try {
        this.logger.log(`[KYC Upload] Starting AI validation for user: ${userId}`);
        const cniFrontBuffers = cniFrontFiles.map(file => file.buffer);
        const validationResult = await this.kycValidationService.validateKyc(
          cniFrontBuffers,
          selfieFile.buffer,
        );

        this.logger.log(`[KYC Upload] Validation result received:`);
        this.logger.log(`[KYC Upload]   - Valid: ${validationResult.isValid}`);
        this.logger.log(`[KYC Upload]   - Face match: ${validationResult.faceMatch.matched} (similarity: ${validationResult.faceMatch.similarity.toFixed(2)}%)`);
        this.logger.log(`[KYC Upload]   - CNI face detected: ${validationResult.faceDetection.cniFront}`);
        this.logger.log(`[KYC Upload]   - Selfie face detected: ${validationResult.faceDetection.selfie}`);
        if (validationResult.reason) {
          this.logger.log(`[KYC Upload]   - Reason: ${validationResult.reason}`);
        }

        if (validationResult.isValid) {
          kycStatus = KycStatus.APPROVED;
          isApprovalConfirmed = true;
          this.logger.log(`[KYC Upload] ✅ KYC validation SUCCESSFUL for user: ${userId} - Status set to APPROVED`);
        } else {
          kycStatus = KycStatus.REJECTED;
          // Construire un message d'erreur détaillé avec toutes les informations
          let detailedReason = validationResult.reason || 'ÉCHEC : Validation KYC échouée';
          
          // Ajouter les détails techniques si disponibles
          if (validationResult.details) {
            const details = validationResult.details;
            detailedReason += '\n\nDétails techniques :';
            
            if (details.issue) {
              detailedReason += `\n- Problème identifié : ${details.issue}`;
            }
            
            if (details.cniFrontFaces !== undefined) {
              detailedReason += `\n- Visages détectés sur CNI : ${details.cniFrontFaces}`;
            }
            
            if (details.selfieFaces !== undefined) {
              detailedReason += `\n- Visages détectés sur selfie : ${details.selfieFaces}`;
            }
            
            if (details.similarityScore !== undefined) {
              detailedReason += `\n- Score de similarité : ${details.similarityScore.toFixed(1)}% (minimum requis : ${details.minRequiredSimilarity || this.configService.get<string>('AWS_REKOGNITION_KYC_MIN_SIMILARITY') || '80'}%)`;
            }
            
            if (details.cniQuality !== undefined || details.selfieQuality !== undefined) {
              detailedReason += '\n- Qualité des images :';
              if (details.cniQuality !== undefined) {
                if (Array.isArray(details.cniQuality)) {
                  detailedReason += `\n  • CNI : ${details.cniQuality.map(q => q.toFixed(1)).join('%, ')}%`;
                } else {
                  detailedReason += `\n  • CNI : ${details.cniQuality.toFixed(1)}%`;
                }
              }
              if (details.selfieQuality !== undefined) {
                detailedReason += `\n  • Selfie : ${details.selfieQuality.toFixed(1)}%`;
              }
              if (details.minRequiredQuality !== undefined) {
                detailedReason += `\n  • Minimum requis : ${details.minRequiredQuality}%`;
              }
            }
            
            if (details.recommendation) {
              detailedReason += `\n\n💡 Recommandation : ${details.recommendation}`;
            }
          }
          
          rejectionReason = detailedReason;
          this.logger.warn(`[KYC Upload] ❌ KYC validation FAILED for user: ${userId}`);
          this.logger.warn(`[KYC Upload] Reason: ${validationResult.reason}`);
          if (validationResult.details?.issue) {
            this.logger.warn(`[KYC Upload] Issue type: ${validationResult.details.issue}`);
          }
          this.logger.warn(`[KYC Upload] Status set to REJECTED`);
        }
      } catch (error) {
        this.logger.error(`[KYC Upload] ❌ KYC validation ERROR for user: ${userId}:`);
        this.logger.error(`[KYC Upload] Error message: ${error.message}`);
        this.logger.error(`[KYC Upload] Error stack: ${error.stack}`);
        
        // En cas d'erreur technique du service IA, mettre le statut à PENDING pour validation manuelle
        kycStatus = KycStatus.PENDING;
        
        // Construire un message clair pour l'utilisateur
        const errorMessage = error.message || 'Erreur inconnue';
        rejectionReason = `VALIDATION MANUELLE REQUISE : Le service de validation automatique n'est pas disponible actuellement.\n\nVotre demande sera examinée manuellement par notre équipe dans les plus brefs délais.\n\nRaison technique : ${errorMessage}`;
        
        this.logger.warn(`[KYC Upload] ⚠️ KYC validation service unavailable - Status set to PENDING for manual review`);
        this.logger.warn(`[KYC Upload] User will be notified that manual review is required`);
      }
    } else {
      const kycEnabledConfig = this.configService.get<string>('AWS_REKOGNITION_KYC_ENABLED');
      const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
      const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');
      
      this.logger.warn(`[KYC Upload] ⚠️ KYC validation is DISABLED`);
      this.logger.warn(`[KYC Upload] Reason: AWS_REKOGNITION_KYC_ENABLED="${kycEnabledConfig || 'NOT SET'}" (must be "true" to enable)`);
      
      if (!accessKeyId || !secretAccessKey) {
        this.logger.warn(`[KYC Upload] Additional issue: AWS credentials not configured`);
        this.logger.warn(`[KYC Upload]   - AWS_ACCESS_KEY_ID: ${accessKeyId ? 'configured' : 'NOT SET'}`);
        this.logger.warn(`[KYC Upload]   - AWS_SECRET_ACCESS_KEY: ${secretAccessKey ? 'configured' : 'NOT SET'}`);
      }
      
      this.logger.warn(`[KYC Upload] Action: Keeping status as PENDING for manual review`);
      this.logger.warn(`[KYC Upload] To enable AI validation, set AWS_REKOGNITION_KYC_ENABLED=true and configure AWS credentials`);
      
      // When KYC validation is disabled, keep status as PENDING for manual review
      kycStatus = KycStatus.PENDING;
    }
    
    this.logger.log(`[KYC Upload] Final KYC status: ${kycStatus}`);
    this.logger.log(`[KYC Upload] ========================================`);

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
          cniFrontUrls, // Store array of CNI front URLs
          cniBackUrl,
          selfieUrl,
          status: kycStatus,
          rejectionReason,
          documentNumber: uploadKycDto.documentNumber,
        });

      kycDocument = queryRunner.manager.merge(KycDocument, kycDocument, {
        user: user, // <-- TypeORM BUG FIX: Pass the user object
        cniFrontUrl,
        cniFrontUrls, // Store array of CNI front URLs
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
          ...cniFrontUrls.map(url => this.fileUploadService.deleteFile(url)),
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

  /**
   * Send OTP for phone verification
   * @param sendOtpDto DTO containing phone number and context
   * @returns Success message
   */
  async sendPhoneVerificationOtp(
    sendOtpDto: SendPhoneVerificationOtpDto,
  ): Promise<{ message: string }> {
    this.logger.log(`Sending phone verification OTP to: ${sendOtpDto.phone} (context: ${sendOtpDto.context})`);

    // Check if phone number already exists in database
    const existingUser = await this.userRepository.findOne({
      where: { phone: sendOtpDto.phone },
    });

    // Different logic based on context
    if (sendOtpDto.context === PhoneVerificationContext.REGISTRATION) {
      // For registration: if user exists, return error
      if (existingUser) {
        this.logger.warn(`Registration failed: Phone ${sendOtpDto.phone} already exists`);
        throw new BadRequestException('Ce numéro de téléphone est déjà utilisé');
      }
    } else if (sendOtpDto.context === PhoneVerificationContext.LOGIN || sendOtpDto.context === PhoneVerificationContext.UPDATE) {
      // For login or update: if user doesn't exist, return error
      if (!existingUser) {
        this.logger.warn(`Login/Update failed: Phone ${sendOtpDto.phone} not found`);
        throw new BadRequestException('Aucun compte trouvé avec ce numéro de téléphone');
      }
    }

    // Send OTP using Keccel service
    const message = 'Votre code de vérification Zwanga est : %OTP%';
    await this.keccelOtpService.sendOtp(sendOtpDto.phone.trim(), message);

    this.logger.log(`Phone verification OTP sent successfully to ${sendOtpDto.phone} (context: ${sendOtpDto.context})`);
    return { message: 'Code de vérification envoyé avec succès' };
  }

  /**
   * Verify OTP without modifying user data
   * @param verifyOtpDto DTO containing phone number and OTP code
   * @returns Verification result
   */
  async verifyPhoneOtp(
    verifyOtpDto: VerifyPhoneOtpDto,
  ): Promise<{ message: string; valid: boolean }> {
    this.logger.log(`Verifying phone OTP for: ${verifyOtpDto.phone}`);

    // Verify OTP using Keccel service
    const verificationResult = await this.keccelOtpService.verifyOtp(
      verifyOtpDto.phone,
      verifyOtpDto.otp,
    );

    if (!verificationResult.valid) {
      this.logger.warn(`Phone verification failed: Invalid OTP for phone ${verifyOtpDto.phone}`);
      throw new BadRequestException('Code OTP invalide ou expiré');
    }

    // Just return the verification result without modifying any user data
    this.logger.log(`Phone OTP verified successfully for: ${verifyOtpDto.phone}`);
    return {
      message: 'Code OTP vérifié avec succès',
      valid: true,
    };
  }

  // ==================== Favorite Locations Methods ====================

  async createFavoriteLocation(userId: string, createDto: CreateFavoriteLocationDto): Promise<FavoriteLocationResponse> {
    this.logger.log(`Creating favorite location for user ${userId}: ${createDto.name}`);

    // Build Point from coordinates
    const point: Point = {
      type: 'Point',
      coordinates: [createDto.coordinates.longitude, createDto.coordinates.latitude],
    };

    // If setting as default, unset other defaults of the same type
    if (createDto.isDefault) {
      await this.favoriteLocationRepository.update(
        {
          userId,
          type: createDto.type || FavoriteLocationType.OTHER,
          isDefault: true,
        },
        { isDefault: false },
      );
    }

    const favoriteLocation = this.favoriteLocationRepository.create({
      userId,
      name: createDto.name,
      address: createDto.address,
      point,
      type: createDto.type || FavoriteLocationType.OTHER,
      isDefault: createDto.isDefault || false,
      notes: createDto.notes || null,
    });

    const saved = await this.favoriteLocationRepository.save(favoriteLocation);
    this.logger.log(`Favorite location created successfully: ${saved.id}`);

    return this.mapFavoriteLocationToResponse(saved);
  }

  async findAllFavoriteLocations(userId: string): Promise<FavoriteLocationResponse[]> {
    this.logger.debug(`Fetching favorite locations for user ${userId}`);

    const locations = await this.favoriteLocationRepository.find({
      where: { userId },
      order: { isDefault: 'DESC', createdAt: 'ASC' },
    });

    return locations.map((loc) => this.mapFavoriteLocationToResponse(loc));
  }

  async findFavoriteLocationById(userId: string, locationId: string): Promise<FavoriteLocationResponse> {
    const location = await this.favoriteLocationRepository.findOne({
      where: { id: locationId, userId },
    });

    if (!location) {
      this.logger.warn(`Favorite location ${locationId} not found for user ${userId}`);
      throw new NotFoundException('Favorite location not found');
    }

    return this.mapFavoriteLocationToResponse(location);
  }

  async updateFavoriteLocation(
    userId: string,
    locationId: string,
    updateDto: UpdateFavoriteLocationDto,
  ): Promise<FavoriteLocationResponse> {
    this.logger.log(`Updating favorite location ${locationId} for user ${userId}`);

    const location = await this.favoriteLocationRepository.findOne({
      where: { id: locationId, userId },
    });

    if (!location) {
      this.logger.warn(`Favorite location ${locationId} not found for user ${userId}`);
      throw new NotFoundException('Favorite location not found');
    }

    // If setting as default, unset other defaults of the same type
    if (updateDto.isDefault === true) {
      const typeToUpdate = updateDto.type || location.type;
      await this.favoriteLocationRepository.update(
        {
          userId,
          id: Not(locationId),
          type: typeToUpdate,
          isDefault: true,
        },
        { isDefault: false },
      );
    }

    // Update point if coordinates are provided
    if (updateDto.coordinates) {
      location.point = {
        type: 'Point',
        coordinates: [updateDto.coordinates.longitude, updateDto.coordinates.latitude],
      };
    }

    // Update other fields
    if (updateDto.name !== undefined) location.name = updateDto.name;
    if (updateDto.address !== undefined) location.address = updateDto.address;
    if (updateDto.type !== undefined) location.type = updateDto.type;
    if (updateDto.isDefault !== undefined) location.isDefault = updateDto.isDefault;
    if (updateDto.notes !== undefined) location.notes = updateDto.notes;

    const updated = await this.favoriteLocationRepository.save(location);
    this.logger.log(`Favorite location updated successfully: ${updated.id}`);

    return this.mapFavoriteLocationToResponse(updated);
  }

  async deleteFavoriteLocation(userId: string, locationId: string): Promise<void> {
    this.logger.log(`Deleting favorite location ${locationId} for user ${userId}`);

    const location = await this.favoriteLocationRepository.findOne({
      where: { id: locationId, userId },
    });

    if (!location) {
      this.logger.warn(`Favorite location ${locationId} not found for user ${userId}`);
      throw new NotFoundException('Favorite location not found');
    }

    await this.favoriteLocationRepository.remove(location);
    this.logger.log(`Favorite location deleted successfully: ${locationId}`);
  }

  async getDefaultFavoriteLocation(userId: string, type?: FavoriteLocationType): Promise<FavoriteLocationResponse | null> {
    const where: any = { userId, isDefault: true };
    if (type) {
      where.type = type;
    }

    const location = await this.favoriteLocationRepository.findOne({ where });

    return location ? this.mapFavoriteLocationToResponse(location) : null;
  }

  private mapFavoriteLocationToResponse(location: FavoriteLocation): FavoriteLocationResponse {
    const point = location.point as any;
    return {
      id: location.id,
      name: location.name,
      address: location.address,
      coordinates: {
        latitude: point.coordinates[1],
        longitude: point.coordinates[0],
      },
      type: location.type,
      isDefault: location.isDefault,
      notes: location.notes,
      createdAt: location.createdAt,
      updatedAt: location.updatedAt,
    };
  }
}

