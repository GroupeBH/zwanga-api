import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RekognitionClient,
  CompareFacesCommand,
  DetectFacesCommand,
  CompareFacesResponse,
  DetectFacesResponse,
} from '@aws-sdk/client-rekognition';

export interface KycValidationResult {
  isValid: boolean;
  faceMatch: {
    similarity: number;
    matched: boolean;
  };
  faceDetection: {
    cniFront: boolean;
    selfie: boolean;
  };
  reason?: string;
  details?: {
    cniFrontFaces?: number;
    selfieFaces?: number;
    similarityScore?: number;
  };
}

@Injectable()
export class KycValidationService {
  private readonly logger = new Logger(KycValidationService.name);
  private rekognitionClient: RekognitionClient | null = null;
  private readonly enabled: boolean;
  private readonly minSimilarity: number; // Minimum similarity score for face match (0-100)
  private readonly minFaceQuality: number; // Minimum face quality threshold

  constructor(private configService: ConfigService) {
    this.enabled = this.configService.get<string>('AWS_REKOGNITION_KYC_ENABLED') === 'true';
    this.minSimilarity = parseFloat(
      this.configService.get<string>('AWS_REKOGNITION_KYC_MIN_SIMILARITY') || '80',
    );
    this.minFaceQuality = parseFloat(
      this.configService.get<string>('AWS_REKOGNITION_KYC_MIN_FACE_QUALITY') || '50',
    );

    if (this.enabled) {
      const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
      const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');

      if (!accessKeyId || !secretAccessKey) {
        this.logger.warn(
          'AWS credentials not configured. KYC validation will be disabled.',
        );
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

      this.logger.log(
        `KYC validation service initialized - Min similarity: ${this.minSimilarity}%, Min face quality: ${this.minFaceQuality}%`,
      );
    } else {
      this.logger.debug('KYC validation is disabled');
    }
  }

  /**
   * Validate KYC documents by comparing selfie with CNI photo
   * @param cniFrontImage Buffer containing CNI front image
   * @param selfieImage Buffer containing selfie image
   * @returns Validation result
   */
  async validateKyc(
    cniFrontImage: Buffer,
    selfieImage: Buffer,
  ): Promise<KycValidationResult> {
    // If validation is disabled, approve automatically
    if (!this.enabled) {
      this.logger.debug('KYC validation is disabled, approving automatically');
      return {
        isValid: true,
        faceMatch: {
          similarity: 100,
          matched: true,
        },
        faceDetection: {
          cniFront: true,
          selfie: true,
        },
      };
    }

    if (!this.rekognitionClient) {
      this.logger.warn(
        'Rekognition client not initialized. Approving KYC automatically.',
      );
      return {
        isValid: true,
        faceMatch: {
          similarity: 100,
          matched: true,
        },
        faceDetection: {
          cniFront: true,
          selfie: true,
        },
      };
    }

    try {
      this.logger.debug('Starting KYC validation with AWS Rekognition');

      // Step 1: Detect faces in both images
      const [cniFaceDetection, selfieFaceDetection] = await Promise.all([
        this.detectFaces(cniFrontImage),
        this.detectFaces(selfieImage),
      ]);

      // Step 2: Validate face detection
      if (!cniFaceDetection.hasFace) {
        this.logger.warn('No face detected in CNI front image');
        return {
          isValid: false,
          faceMatch: {
            similarity: 0,
            matched: false,
          },
          faceDetection: {
            cniFront: false,
            selfie: selfieFaceDetection.hasFace,
          },
          reason: 'Aucun visage détecté sur la photo de la CNI',
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
          },
        };
      }

      if (!selfieFaceDetection.hasFace) {
        this.logger.warn('No face detected in selfie image');
        return {
          isValid: false,
          faceMatch: {
            similarity: 0,
            matched: false,
          },
          faceDetection: {
            cniFront: true,
            selfie: false,
          },
          reason: 'Aucun visage détecté sur la photo selfie',
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
          },
        };
      }

      // Step 3: Check if multiple faces detected (should be only one)
      if (cniFaceDetection.faceCount > 1) {
        this.logger.warn(
          `Multiple faces detected in CNI front image (${cniFaceDetection.faceCount})`,
        );
        return {
          isValid: false,
          faceMatch: {
            similarity: 0,
            matched: false,
          },
          faceDetection: {
            cniFront: true,
            selfie: true,
          },
          reason: 'Plusieurs visages détectés sur la photo de la CNI. Un seul visage est autorisé.',
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
          },
        };
      }

      if (selfieFaceDetection.faceCount > 1) {
        this.logger.warn(
          `Multiple faces detected in selfie image (${selfieFaceDetection.faceCount})`,
        );
        return {
          isValid: false,
          faceMatch: {
            similarity: 0,
            matched: false,
          },
          faceDetection: {
            cniFront: true,
            selfie: true,
          },
          reason: 'Plusieurs visages détectés sur la photo selfie. Un seul visage est autorisé.',
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
          },
        };
      }

      // Step 4: Check face quality
      if (
        cniFaceDetection.faceQuality < this.minFaceQuality ||
        selfieFaceDetection.faceQuality < this.minFaceQuality
      ) {
        this.logger.warn(
          `Low face quality detected - CNI: ${cniFaceDetection.faceQuality}%, Selfie: ${selfieFaceDetection.faceQuality}%`,
        );
        return {
          isValid: false,
          faceMatch: {
            similarity: 0,
            matched: false,
          },
          faceDetection: {
            cniFront: true,
            selfie: true,
          },
          reason: `Qualité des images insuffisante. Veuillez prendre des photos plus claires.`,
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
          },
        };
      }

      // Step 5: Compare faces
      const faceComparison = await this.compareFaces(
        cniFrontImage,
        selfieImage,
      );

      const similarity = faceComparison.similarity;
      const matched = similarity >= this.minSimilarity;

      if (!matched) {
        this.logger.warn(
          `Face comparison failed - Similarity: ${similarity}% (minimum: ${this.minSimilarity}%)`,
        );
        return {
          isValid: false,
          faceMatch: {
            similarity,
            matched: false,
          },
          faceDetection: {
            cniFront: true,
            selfie: true,
          },
          reason: `Les visages ne correspondent pas. Score de similarité: ${similarity.toFixed(1)}% (minimum requis: ${this.minSimilarity}%)`,
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
            similarityScore: similarity,
          },
        };
      }

      this.logger.log(
        `KYC validation successful - Similarity: ${similarity.toFixed(1)}%`,
      );

      return {
        isValid: true,
        faceMatch: {
          similarity,
          matched: true,
        },
        faceDetection: {
          cniFront: true,
          selfie: true,
        },
        details: {
          cniFrontFaces: cniFaceDetection.faceCount,
          selfieFaces: selfieFaceDetection.faceCount,
          similarityScore: similarity,
        },
      };
    } catch (error) {
      this.logger.error('KYC validation error:', error);
      throw new InternalServerErrorException(
        'Erreur lors de la validation KYC. Veuillez réessayer.',
      );
    }
  }

  /**
   * Detect faces in an image
   * @param imageBuffer Buffer containing image data
   * @returns Face detection result
   */
  private async detectFaces(imageBuffer: Buffer): Promise<{
    hasFace: boolean;
    faceCount: number;
    faceQuality: number; // Average quality score of detected faces
  }> {
    if (!this.rekognitionClient) {
      return { hasFace: false, faceCount: 0, faceQuality: 0 };
    }

    try {
      const command = new DetectFacesCommand({
        Image: {
          Bytes: imageBuffer,
        },
        Attributes: ['ALL'], // ALL includes quality, eyes_open, mouth_open, etc.
      });

      const response: DetectFacesResponse =
        await this.rekognitionClient.send(command);

      const faces = response.FaceDetails || [];
      const faceCount = faces.length;

      if (faceCount === 0) {
        return { hasFace: false, faceCount: 0, faceQuality: 0 };
      }

      // Calculate average quality score
      const totalQuality = faces.reduce((sum, face) => {
        const quality = face.Quality;
        if (!quality) return sum;
        // Quality score is a combination of brightness, sharpness, etc.
        const qualityScore =
          (quality.Brightness || 0) * 0.3 +
          (quality.Sharpness || 0) * 0.7;
        return sum + qualityScore;
      }, 0);

      const averageQuality = totalQuality / faceCount;

      return {
        hasFace: true,
        faceCount,
        faceQuality: averageQuality,
      };
    } catch (error) {
      this.logger.error('Face detection error:', error);
      throw new InternalServerErrorException('Erreur lors de la détection des visages');
    }
  }

  /**
   * Compare faces between two images
   * @param sourceImage Buffer containing source image (CNI)
   * @param targetImage Buffer containing target image (selfie)
   * @returns Face comparison result
   */
  private async compareFaces(
    sourceImage: Buffer,
    targetImage: Buffer,
  ): Promise<{ similarity: number }> {
    if (!this.rekognitionClient) {
      return { similarity: 0 };
    }

    try {
      const command = new CompareFacesCommand({
        SourceImage: {
          Bytes: sourceImage,
        },
        TargetImage: {
          Bytes: targetImage,
        },
        SimilarityThreshold: this.minSimilarity,
      });

      const response: CompareFacesResponse =
        await this.rekognitionClient.send(command);

      const faceMatches = response.FaceMatches || [];

      if (faceMatches.length === 0) {
        return { similarity: 0 };
      }

      // Get the highest similarity score
      const maxSimilarity = Math.max(
        ...faceMatches.map((match) => match.Similarity || 0),
      );

      return { similarity: maxSimilarity };
    } catch (error) {
      this.logger.error('Face comparison error:', error);
      throw new InternalServerErrorException('Erreur lors de la comparaison des visages');
    }
  }
}

