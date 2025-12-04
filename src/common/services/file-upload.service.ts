import { Injectable, BadRequestException, Inject, Optional, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import * as crypto from 'crypto';
import { S3Service } from './s3.service';
import { ContentModerationService, ModerationResult } from './content-moderation.service';

@Injectable()
export class FileUploadService {
  private readonly logger = new Logger(FileUploadService.name);
  private readonly uploadPath: string;
  private readonly useS3: boolean;
  private readonly useModeration: boolean;

  constructor(
    private configService: ConfigService,
    @Optional() @Inject(S3Service) private s3Service?: S3Service,
    @Optional() @Inject(ContentModerationService) private contentModerationService?: ContentModerationService,
  ) {
    this.uploadPath = this.configService.get<string>('UPLOAD_DEST') || './uploads';
    this.useS3 = this.configService.get<string>('AWS_S3_BUCKET_NAME') ? true : false;
    this.useModeration = this.configService.get<string>('AWS_REKOGNITION_ENABLED') === 'true';

    if (!this.useS3) {
      this.ensureUploadDirectory();
    }
  }

  private async ensureUploadDirectory() {
    try {
      await fs.access(this.uploadPath);
    } catch {
      await fs.mkdir(this.uploadPath, { recursive: true });
      await fs.mkdir(join(this.uploadPath, 'profiles'), { recursive: true });
      await fs.mkdir(join(this.uploadPath, 'kyc'), { recursive: true });
    }
  }

  /**
   * Save a file with content moderation and upload to S3 or local storage
   * @param file File object with buffer, mimetype, size, and originalname
   * @param subfolder Subfolder for organization (profiles, kyc, vehicles)
   * @returns File path/key for database storage
   */
  async saveFile(
    file: { mimetype: string; size: number; originalname: string; buffer: Buffer },
    subfolder: 'profiles' | 'kyc' | 'vehicles',
  ): Promise<string | null> {
    if (!file) {
      return null;
    }

    this.logger.debug(`Processing file upload: ${file.originalname} (${file.mimetype}, ${(file.size / 1024).toFixed(2)}KB) to ${subfolder}`);

    // Validate file type
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedMimes.includes(file.mimetype)) {
      this.logger.warn(`File upload rejected: Invalid file type ${file.mimetype} for file ${file.originalname}`);
      throw new BadRequestException(
        `Invalid file type. Allowed types: ${allowedMimes.join(', ')}`,
      );
    }

    // Validate file size (5MB max)
    const maxSize = this.configService.get<number>('MAX_FILE_SIZE') || 5242880;
    if (file.size > maxSize) {
      this.logger.warn(`File upload rejected: File size ${(file.size / 1024 / 1024).toFixed(2)}MB exceeds limit for file ${file.originalname}`);
      throw new BadRequestException(`File size exceeds ${maxSize / 1024 / 1024}MB limit`);
    }

    // Content moderation - check for inappropriate content
    if (this.useModeration && this.contentModerationService) {
      try {
        this.logger.debug(`Running content moderation for file: ${file.originalname}`);
        const moderationResult: ModerationResult = await this.contentModerationService.moderateImage(file.buffer);

        if (!moderationResult.isApproved) {
          this.logger.warn(`File upload rejected: Content moderation failed for ${file.originalname} - ${moderationResult.reason}`);
          throw new BadRequestException(
            moderationResult.reason || 'Image contains inappropriate content and cannot be uploaded',
          );
        }
        
        this.logger.debug(`Content moderation passed for file: ${file.originalname}`);
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
        // If moderation service fails, log but don't block upload (can be configured differently)
        this.logger.error(`Content moderation failed for file ${file.originalname}:`, error);
        // For safety, you might want to throw here instead
        // throw new BadRequestException('Failed to verify image content');
      }
    }

    // Upload to S3 or save locally
    if (this.useS3 && this.s3Service) {
      try {
        this.logger.debug(`Uploading file to S3: ${file.originalname} to ${subfolder}`);
        const s3Key = await this.s3Service.uploadFile(
          file.buffer,
          subfolder,
          file.mimetype,
          file.originalname,
        );
        this.logger.log(`File uploaded to S3 successfully: ${s3Key}`);

        const publicUrl = this.s3Service.getPublicUrl(s3Key);
        return publicUrl;
      } catch (error) {
        this.logger.error(`S3 upload failed for file ${file.originalname}:`, error);
        throw new BadRequestException('Failed to upload file to cloud storage');
      }
    } else {
      // Local storage fallback
      this.logger.debug(`Saving file locally: ${file.originalname} to ${subfolder}`);
      const fileExtension = file.originalname.split('.').pop();
      const uniqueName = `${crypto.randomUUID()}.${fileExtension}`;
      const filePath = join(this.uploadPath, subfolder, uniqueName);

      await fs.writeFile(filePath, file.buffer);

      this.logger.log(`File saved locally successfully: ${subfolder}/${uniqueName}`);
      return `${subfolder}/${uniqueName}`;
    }
  }

  /**
   * Delete a file from S3 or local storage
   * @param filePath File path/key to delete
   */
  async deleteFile(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }

    this.logger.debug(`Deleting file: ${filePath}`);

    if (this.useS3 && this.s3Service) {
      await this.s3Service.deleteFile(filePath);
      this.logger.debug(`File deleted from S3: ${filePath}`);
    } else {
      try {
        const fullPath = join(this.uploadPath, filePath);
        await fs.unlink(fullPath);
        this.logger.debug(`File deleted locally: ${filePath}`);
      } catch (error) {
        this.logger.warn(`Failed to delete file ${filePath}:`, error.message);
      }
    }
  }

  /**
   * Get URL for accessing a file
   * @param filePath File path/key
   * @param usePresignedUrl Whether to use presigned URL for S3 (default: true for S3)
   * @returns File URL
   */
  async getFileUrl(filePath: string, usePresignedUrl: boolean = true): Promise<string | null> {
    if (!filePath) {
      return null;
    }

    if (this.useS3 && this.s3Service) {
      // Check if bucket is public or use presigned URL
      const usePublicUrl = this.configService.get<string>('AWS_S3_PUBLIC_BUCKET') === 'true';
      
      if (usePublicUrl) {
        return this.s3Service.getPublicUrl(filePath);
      } else if (usePresignedUrl) {
        const expiresIn = this.configService.get<number>('AWS_S3_PRESIGNED_URL_EXPIRES_IN') || 3600;
        return await this.s3Service.getPresignedUrl(filePath, expiresIn);
      } else {
        return this.s3Service.getPublicUrl(filePath);
      }
    } else {
      // Local storage
      return `/uploads/${filePath}`;
    }
  }
}

