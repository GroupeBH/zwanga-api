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

        // Return S3 key instead of public URL - we'll generate presigned URLs when needed
        return s3Key;
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
   * @param filePath File path/key to delete (can be S3 key or URL)
   */
  async deleteFile(filePath: any): Promise<void> {
    if (!filePath) {
      return;
    }

    this.logger.debug(`Deleting file: ${filePath}`);

    if (this.useS3 && this.s3Service) {
      // Extract S3 key from URL if it's a URL, otherwise use as-is
      let s3Key = filePath;
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        // Extract key from URL (e.g., https://bucket.s3.region.amazonaws.com/profiles/uuid.jpg -> profiles/uuid.jpg)
        try {
          const url = new URL(filePath);
          // Remove leading slash from pathname
          s3Key = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
        } catch (error) {
          this.logger.warn(`Failed to parse URL ${filePath}, using as-is`);
        }
      }
      await this.s3Service.deleteFile(s3Key);
      this.logger.debug(`File deleted from S3: ${s3Key}`);
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
   * @param filePath File path/key (S3 key or local path)
   * @param usePresignedUrl Whether to use presigned URL for S3 (default: true for S3)
   * @returns File URL (presigned URL for S3, local path for local storage)
   */
  async getFileUrl(filePath: string, usePresignedUrl: boolean = true): Promise<string | null> {
    if (!filePath) {
      return null;
    }

    if (this.useS3 && this.s3Service) {
      // Always use presigned URLs for S3 private buckets
      if (usePresignedUrl) {
        const expiresIn = this.configService.get<number>('AWS_S3_PRESIGNED_URL_EXPIRES_IN') || 3600;
        return await this.s3Service.getPresignedUrl(filePath, expiresIn);
      } else {
        // Fallback to public URL if bucket is public (not recommended)
        const usePublicUrl = this.configService.get<string>('AWS_S3_PUBLIC_BUCKET') === 'true';
        if (usePublicUrl) {
          return this.s3Service.getPublicUrl(filePath);
        }
        // Default to presigned URL even if usePresignedUrl is false
        const expiresIn = this.configService.get<number>('AWS_S3_PRESIGNED_URL_EXPIRES_IN') || 3600;
        return await this.s3Service.getPresignedUrl(filePath, expiresIn);
      }
    } else {
      // Local storage
      return `/uploads/${filePath}`;
    }
  }

  /**
   * Convert S3 keys to presigned URLs for user data
   * @param s3Key S3 key (path) or null
   * @returns Presigned URL or null
   */
  async getPresignedUrlIfS3Key(s3Key: string | null): Promise<string | null> {
    if (!s3Key) {
      return null;
    }

    // Check if it's an S3 key (contains /) or already a URL
    if (s3Key.startsWith('http://') || s3Key.startsWith('https://')) {
      // Already a URL, return as is
      return s3Key;
    }

    // It's an S3 key, generate presigned URL
    return await this.getFileUrl(s3Key, true);
  }
}

