import { Injectable, BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RekognitionClient, DetectModerationLabelsCommand } from '@aws-sdk/client-rekognition';

export interface ModerationResult {
  isApproved: boolean;
  moderationLabels: Array<{
    name: string;
    confidence: number;
    parentName?: string;
  }>;
  reason?: string;
}

@Injectable()
export class ContentModerationService {
  private readonly logger = new Logger(ContentModerationService.name);
  private rekognitionClient: RekognitionClient | null = null;
  private readonly minConfidence: number;
  private readonly enabled: boolean;

  // Labels to block (AWS Rekognition moderation labels)
  private readonly blockedLabels = [
    'Explicit Nudity',
    'Violence',
    'Visually Disturbing',
    'Rude Gestures',
    'Drugs',
    'Tobacco',
    'Alcohol',
    'Gambling',
    'Hate Symbols',
    'Suggestive',
    'Graphic Violence',
    'Graphic Violence Or Death',
    'Physical Violence',
    'Weapon Violence',
    'Self Injury',
    'Emotional Abuse',
    'Harassment',
    'Spam',
    'Illegal Activities',
    'Shocking',
    'Adult Content',
    'Nudity',
    'Graphic Male Nudity',
    'Graphic Female Nudity',
    'Sexual Activity',
    'Illustrated Explicit Nudity',
    'Adult Toys',
    'Female Swimwear Or Underwear',
    'Male Swimwear Or Underwear',
    'Partial Nudity',
    'Barechested Male',
    'Revealing Clothes',
    'Sexual Situations',
    'Graphic Violence Or Gore',
    'Physical Violence',
    'Weapon Violence',
    'Weapons',
    'Self Injury',
    'Emotional Abuse',
    'Harassment',
    'Spam',
    'Illegal Activities',
    'Shocking',
    'Terrorism',
    'Disturbing',
    'Blood',
    'Corpses',
    'Hanging',
    'Air Crash',
    'Explosions And Blasts',
    'Middle Finger',
    'Drug Products',
    'Drug Use',
    'Drug Paraphernalia',
    'Tobacco Products',
    'Smoking',
    'Drinking',
    'Gambling',
    'Hate Symbols',
    'Nazi Party',
    'White Supremacy',
    'Extremist',
  ];

  constructor(private configService: ConfigService) {
    this.enabled = this.configService.get<string>('AWS_REKOGNITION_ENABLED') === 'true';
    this.minConfidence = parseFloat(this.configService.get<string>('AWS_REKOGNITION_MIN_CONFIDENCE') || '50');

    if (this.enabled) {
      const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
      const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');

      if (!accessKeyId || !secretAccessKey) {
        this.logger.warn('AWS credentials not configured. Content moderation will be disabled.');
        this.enabled = false;
        return;
      }

      this.rekognitionClient = new RekognitionClient({
        region: this.configService.get<string>('AWS_REGION') || 'us-east-1',
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      
      this.logger.log(`Content moderation service initialized - Min confidence: ${this.minConfidence}%`);
    } else {
      this.logger.debug('Content moderation is disabled');
    }
  }

  /**
   * Moderate an image to detect inappropriate content
   * @param imageBuffer Buffer containing image data
   * @returns Moderation result
   */
  async moderateImage(imageBuffer: Buffer): Promise<ModerationResult> {
    // If moderation is disabled, approve all images
    if (!this.enabled) {
      return {
        isApproved: true,
        moderationLabels: [],
      };
    }

    if (!this.rekognitionClient) {
      // If moderation is enabled but client is not initialized, approve the image
      this.logger.warn('Rekognition client not initialized. Approving image.');
      return {
        isApproved: true,
        moderationLabels: [],
      };
    }

    try {
      this.logger.debug(`Running content moderation (min confidence: ${this.minConfidence}%)`);
      
      const command = new DetectModerationLabelsCommand({
        Image: {
          Bytes: imageBuffer,
        },
        MinConfidence: this.minConfidence,
      });

      const response = await this.rekognitionClient.send(command);

      const moderationLabels: any = (response.ModerationLabels || []).map((label) => ({
        name: label.Name,
        confidence: label.Confidence,
        parentName: label.ParentName,
      }));

      // Check if any blocked label is detected
      const hasBlockedContent = moderationLabels.some((label: any) =>
        this.blockedLabels.some(
          (blockedLabel) =>
            label.name.toLowerCase().includes(blockedLabel.toLowerCase()) ||
            (label.parentName && label.parentName.toLowerCase().includes(blockedLabel.toLowerCase())),
        ),
      );

      if (hasBlockedContent) {
        const blockedLabelsFound = moderationLabels
          .filter((label: any) =>
            this.blockedLabels.some(
              (blockedLabel) =>
                label.name.toLowerCase().includes(blockedLabel.toLowerCase()) ||
                (label.parentName && label.parentName.toLowerCase().includes(blockedLabel.toLowerCase())),
            ),
          )
          .map((label: any) => `${label.name} (${label.confidence?.toFixed(1) || 0}%)`)
          .join(', ');

        this.logger.warn(`Content moderation rejected image - Labels: ${blockedLabelsFound}`);
        return {
          isApproved: false,
          moderationLabels,
          reason: `Image contains inappropriate content: ${blockedLabelsFound}`,
        };
      }

      this.logger.debug(`Content moderation approved image - Found ${moderationLabels.length} labels (all safe)`);
      return {
        isApproved: true,
        moderationLabels,
      };
    } catch (error) {
      this.logger.error('Content moderation error:', error);
      // If moderation fails, we can either:
      // 1. Reject the image (safer but might block legitimate content)
      // 2. Approve the image (less safe but better UX)
      // We'll reject by default for safety
      throw new InternalServerErrorException('Failed to moderate image content');
    }
  }

  /**
   * Moderate multiple images
   * @param imageBuffers Array of image buffers
   * @returns Array of moderation results
   */
  async moderateImages(imageBuffers: Buffer[]): Promise<ModerationResult[]> {
    const results = await Promise.all(
      imageBuffers.map((buffer) => this.moderateImage(buffer).catch((error) => {
        // If moderation fails for one image, reject it
        return {
          isApproved: false,
          moderationLabels: [],
          reason: error.message || 'Moderation failed',
        };
      })),
    );

    return results;
  }
}

