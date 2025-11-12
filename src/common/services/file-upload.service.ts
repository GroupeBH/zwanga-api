import { Injectable, BadRequestException, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import * as crypto from 'crypto';
import { S3Service } from './s3.service';
import { ContentModerationService, ModerationResult } from './content-moderation.service';

@Injectable()
export class FileUploadService {
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

    // Validate file type
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Invalid file type. Allowed types: ${allowedMimes.join(', ')}`,
      );
    }

    // Validate file size (5MB max)
    const maxSize = this.configService.get<number>('MAX_FILE_SIZE') || 5242880;
    if (file.size > maxSize) {
      throw new BadRequestException(`File size exceeds ${maxSize / 1024 / 1024}MB limit`);
    }

    // Content moderation - check for inappropriate content
    if (this.useModeration && this.contentModerationService) {
      try {
        const moderationResult: ModerationResult = await this.contentModerationService.moderateImage(file.buffer);

        if (!moderationResult.isApproved) {
          throw new BadRequestException(
            moderationResult.reason || 'Image contains inappropriate content and cannot be uploaded',
          );
        }
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
        // If moderation service fails, log but don't block upload (can be configured differently)
        console.error('Content moderation failed:', error);
        // For safety, you might want to throw here instead
        // throw new BadRequestException('Failed to verify image content');
      }
    }

    // Upload to S3 or save locally
    if (this.useS3 && this.s3Service) {
      try {
        const s3Key = await this.s3Service.uploadFile(
          file.buffer,
          subfolder,
          file.mimetype,
          file.originalname,
        );
        return s3Key; // Return S3 key for database storage
      } catch (error) {
        console.error('S3 upload failed:', error);
        throw new BadRequestException('Failed to upload file to cloud storage');
      }
    } else {
      // Local storage fallback
      const fileExtension = file.originalname.split('.').pop();
      const uniqueName = `${crypto.randomUUID()}.${fileExtension}`;
      const filePath = join(this.uploadPath, subfolder, uniqueName);

      await fs.writeFile(filePath, file.buffer);

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

    if (this.useS3 && this.s3Service) {
      await this.s3Service.deleteFile(filePath);
    } else {
      try {
        const fullPath = join(this.uploadPath, filePath);
        await fs.unlink(fullPath);
      } catch (error) {
        console.warn(`Failed to delete file ${filePath}:`, error.message);
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

