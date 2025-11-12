import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';

@Injectable()
export class S3Service {
  private s3Client: S3Client | null = null;
  private readonly bucketName: string | null;
  private readonly region: string;

  constructor(private configService: ConfigService) {
    this.region = this.configService.get<string>('AWS_REGION') || 'us-east-1';
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET_NAME') || null;

    // Only initialize S3 client if bucket name is configured
    if (this.bucketName) {
      const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
      const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');

      if (!accessKeyId || !secretAccessKey) {
        console.warn('AWS credentials not configured. S3 service will not be available.');
        return;
      }

      this.s3Client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    }
  }

  /**
   * Upload a file to S3
   * @param file Buffer containing file data
   * @param subfolder Subfolder in S3 bucket (profiles, kyc, etc.)
   * @param mimetype MIME type of the file
   * @param originalName Original filename
   * @returns S3 key (path) of the uploaded file
   */
  async uploadFile(
    file: Buffer,
    subfolder: 'profiles' | 'kyc' | 'vehicles',
    mimetype: string,
    originalName: string,
  ): Promise<string> {
    if (!this.s3Client || !this.bucketName) {
      throw new InternalServerErrorException('S3 is not configured');
    }

    try {
      // Generate unique filename
      const fileExtension = originalName.split('.').pop();
      const uniqueName = `${crypto.randomUUID()}.${fileExtension}`;
      const key = `${subfolder}/${uniqueName}`;

      // Upload to S3
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file,
        ContentType: mimetype,
        ACL: 'private', // Files are private by default
      });

      await this.s3Client.send(command);

      return key;
    } catch (error) {
      console.error('S3 upload error:', error);
      throw new InternalServerErrorException('Failed to upload file to S3');
    }
  }

  /**
   * Delete a file from S3
   * @param key S3 key (path) of the file to delete
   */
  async deleteFile(key: string): Promise<void> {
    if (!key || !this.s3Client || !this.bucketName) {
      return;
    }

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.s3Client.send(command);
    } catch (error) {
      console.warn(`Failed to delete file from S3 ${key}:`, error.message);
      // Don't throw error, just log warning
    }
  }

  /**
   * Get a presigned URL for temporary access to a private file
   * @param key S3 key (path) of the file
   * @param expiresIn Expiration time in seconds (default: 1 hour)
   * @returns Presigned URL
   */
  async getPresignedUrl(key: string, expiresIn: number = 3600): Promise<any> {
    if (!key || !this.s3Client || !this.bucketName) {
      return null;
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const url = await getSignedUrl(this.s3Client, command, { expiresIn });
      return url;
    } catch (error) {
      console.error('Error generating presigned URL:', error);
      return null;
    }
  }

  /**
   * Get public URL for a file (if bucket is public)
   * @param key S3 key (path) of the file
   * @returns Public URL
   */
  getPublicUrl(key: string): any {
    if (!key || !this.bucketName) {
      return null;
    }

    return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
  }
}

