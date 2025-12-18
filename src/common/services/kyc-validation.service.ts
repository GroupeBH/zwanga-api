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
    issue?: string;
    recommendation?: string;
    cniQuality?: number;
    selfieQuality?: number;
    minRequiredQuality?: number;
    minRequiredSimilarity?: number;
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
    const kycEnabledConfig = this.configService.get<string>('AWS_REKOGNITION_KYC_ENABLED');
    this.enabled = kycEnabledConfig === 'true';
    
    this.logger.log(`[KYC Init] Checking KYC validation configuration...`);
    this.logger.log(`[KYC Init] AWS_REKOGNITION_KYC_ENABLED = "${kycEnabledConfig}" (enabled: ${this.enabled})`);
    
    this.minSimilarity = parseFloat(
      this.configService.get<string>('AWS_REKOGNITION_KYC_MIN_SIMILARITY') || '80',
    );
    this.minFaceQuality = parseFloat(
      this.configService.get<string>('AWS_REKOGNITION_KYC_MIN_FACE_QUALITY') || '50',
    );

    this.logger.log(`[KYC Init] Min similarity threshold: ${this.minSimilarity}%`);
    this.logger.log(`[KYC Init] Min face quality threshold: ${this.minFaceQuality}%`);

    if (this.enabled) {
      const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
      const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');
      const region = this.configService.get<string>('AWS_REGION') || 'us-east-1';

      this.logger.log(`[KYC Init] AWS Region: ${region}`);
      this.logger.log(`[KYC Init] AWS_ACCESS_KEY_ID: ${accessKeyId ? '***configured***' : 'NOT SET'}`);
      this.logger.log(`[KYC Init] AWS_SECRET_ACCESS_KEY: ${secretAccessKey ? '***configured***' : 'NOT SET'}`);

      if (!accessKeyId || !secretAccessKey) {
        this.logger.warn(
          '[KYC Init] AWS credentials not configured. KYC validation will be disabled.',
        );
        this.enabled = false;
        return;
      }

      try {
        this.rekognitionClient = new RekognitionClient({
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
        });

        this.logger.log(
          `[KYC Init] ✅ KYC validation service initialized successfully`,
        );
        this.logger.log(
          `[KYC Init] Configuration: Min similarity: ${this.minSimilarity}%, Min face quality: ${this.minFaceQuality}%`,
        );
      } catch (error) {
        this.logger.error(`[KYC Init] ❌ Failed to initialize Rekognition client: ${error.message}`, error.stack);
        this.enabled = false;
        this.rekognitionClient = null;
      }
    } else {
      this.logger.warn('[KYC Init] ⚠️ KYC validation is DISABLED - All KYC documents will be set to PENDING for manual review');
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
    this.logger.log('[KYC Validation] ========================================');
    this.logger.log('[KYC Validation] Starting KYC validation process');
    this.logger.log(`[KYC Validation] CNI image size: ${cniFrontImage.length} bytes`);
    this.logger.log(`[KYC Validation] Selfie image size: ${selfieImage.length} bytes`);
    
    // If validation is disabled, approve automatically
    if (!this.enabled) {
      this.logger.warn('[KYC Validation] ⚠️ KYC validation is DISABLED - Returning auto-approval');
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
      this.logger.error('[KYC Validation] ❌ Rekognition client not initialized - Service unavailable');
      // Throw error to trigger fallback to manual review (PENDING status)
      throw new InternalServerErrorException(
        'ERREUR TECHNIQUE : Le service de validation automatique n\'est pas disponible. Votre demande sera examinée manuellement.'
      );
    }

    try {
      this.logger.log('[KYC Validation] ✅ Rekognition client is ready');
      this.logger.log('[KYC Validation] Step 1: Detecting faces in CNI and selfie images...');

      // Step 1: Detect faces in both images
      const [cniFaceDetection, selfieFaceDetection] = await Promise.all([
        this.detectFaces(cniFrontImage, 'CNI'),
        this.detectFaces(selfieImage, 'Selfie'),
      ]);

      this.logger.log('[KYC Validation] Step 1 completed:');
      this.logger.log(`[KYC Validation]   - CNI: ${cniFaceDetection.hasFace ? '✅ Face detected' : '❌ No face'} (${cniFaceDetection.faceCount} face(s), quality: ${cniFaceDetection.faceQuality.toFixed(2)}%)`);
      this.logger.log(`[KYC Validation]   - Selfie: ${selfieFaceDetection.hasFace ? '✅ Face detected' : '❌ No face'} (${selfieFaceDetection.faceCount} face(s), quality: ${selfieFaceDetection.faceQuality.toFixed(2)}%)`);

      // Step 2: Validate face detection
      this.logger.log('[KYC Validation] Step 2: Validating face detection results...');
      if (!cniFaceDetection.hasFace) {
        this.logger.warn('[KYC Validation] ❌ No face detected in CNI front image');
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
          reason: `ÉCHEC : Aucun visage détecté sur la photo de la CNI. Veuillez prendre une photo claire de votre carte d'identité où votre visage est bien visible.`,
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
            issue: 'NO_FACE_IN_CNI',
            recommendation: 'Assurez-vous que votre visage est clairement visible sur la photo de la CNI. Évitez les reflets et les ombres.',
          },
        };
      }

      if (!selfieFaceDetection.hasFace) {
        this.logger.warn('[KYC Validation] ❌ No face detected in selfie image');
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
          reason: `ÉCHEC : Aucun visage détecté sur la photo selfie. Veuillez prendre une photo selfie claire où votre visage est bien visible et centré.`,
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
            issue: 'NO_FACE_IN_SELFIE',
            recommendation: 'Prenez une photo selfie avec un bon éclairage, face à la caméra, sans masque ni lunettes de soleil.',
          },
        };
      }

      // Step 3: Check if multiple faces detected (should be only one)
      this.logger.log('[KYC Validation] Step 3: Checking for multiple faces...');
      if (cniFaceDetection.faceCount > 1) {
        this.logger.warn(
          `[KYC Validation] ❌ Multiple faces detected in CNI front image (${cniFaceDetection.faceCount})`,
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
          reason: `ÉCHEC : Plusieurs visages détectés sur la photo de la CNI (${cniFaceDetection.faceCount} visage(s)). Un seul visage est autorisé.`,
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
            issue: 'MULTIPLE_FACES_IN_CNI',
            recommendation: 'Assurez-vous que seule votre photo apparaît sur la carte d\'identité. Évitez les photos avec d\'autres personnes en arrière-plan.',
          },
        };
      }

      if (selfieFaceDetection.faceCount > 1) {
        this.logger.warn(
          `[KYC Validation] ❌ Multiple faces detected in selfie image (${selfieFaceDetection.faceCount})`,
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
          reason: `ÉCHEC : Plusieurs visages détectés sur la photo selfie (${selfieFaceDetection.faceCount} visage(s)). Un seul visage est autorisé.`,
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
            issue: 'MULTIPLE_FACES_IN_SELFIE',
            recommendation: 'Prenez une photo selfie seule, sans autres personnes dans le cadre.',
          },
        };
      }

      // Step 4: Check face quality
      this.logger.log('[KYC Validation] Step 4: Checking face quality...');
      this.logger.log(`[KYC Validation]   - CNI quality: ${cniFaceDetection.faceQuality.toFixed(2)}% (minimum: ${this.minFaceQuality}%)`);
      this.logger.log(`[KYC Validation]   - Selfie quality: ${selfieFaceDetection.faceQuality.toFixed(2)}% (minimum: ${this.minFaceQuality}%)`);
      
      if (
        cniFaceDetection.faceQuality < this.minFaceQuality ||
        selfieFaceDetection.faceQuality < this.minFaceQuality
      ) {
        this.logger.warn(
          `[KYC Validation] ❌ Low face quality detected - CNI: ${cniFaceDetection.faceQuality.toFixed(2)}%, Selfie: ${selfieFaceDetection.faceQuality.toFixed(2)}% (minimum: ${this.minFaceQuality}%)`,
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
          reason: `ÉCHEC : Qualité des images insuffisante. CNI: ${cniFaceDetection.faceQuality.toFixed(1)}% (minimum: ${this.minFaceQuality}%), Selfie: ${selfieFaceDetection.faceQuality.toFixed(1)}% (minimum: ${this.minFaceQuality}%).`,
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
            cniQuality: cniFaceDetection.faceQuality,
            selfieQuality: selfieFaceDetection.faceQuality,
            minRequiredQuality: this.minFaceQuality,
            issue: 'LOW_IMAGE_QUALITY',
            recommendation: 'Prenez des photos avec un bon éclairage, évitez les flous, les reflets et les ombres. Utilisez une caméra de bonne qualité.',
          },
        };
      }

      // Step 5: Compare faces
      this.logger.log('[KYC Validation] Step 5: Comparing faces between CNI and selfie...');
      const faceComparison = await this.compareFaces(
        cniFrontImage,
        selfieImage,
      );

      const similarity = faceComparison.similarity;
      const matched = similarity >= this.minSimilarity;

      this.logger.log(`[KYC Validation] Face comparison result:`);
      this.logger.log(`[KYC Validation]   - Similarity score: ${similarity.toFixed(2)}%`);
      this.logger.log(`[KYC Validation]   - Minimum required: ${this.minSimilarity}%`);
      this.logger.log(`[KYC Validation]   - Match: ${matched ? '✅ PASSED' : '❌ FAILED'}`);

      if (!matched) {
        this.logger.warn(
          `[KYC Validation] ❌ Face comparison failed - Similarity: ${similarity.toFixed(2)}% (minimum: ${this.minSimilarity}%)`,
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
          reason: `ÉCHEC : Les visages ne correspondent pas. Score de similarité: ${similarity.toFixed(1)}% (minimum requis: ${this.minSimilarity}%). La photo selfie ne correspond pas à la photo sur votre carte d'identité.`,
          details: {
            cniFrontFaces: cniFaceDetection.faceCount,
            selfieFaces: selfieFaceDetection.faceCount,
            similarityScore: similarity,
            minRequiredSimilarity: this.minSimilarity,
            issue: 'FACE_MISMATCH',
            recommendation: 'Assurez-vous que la photo selfie correspond bien à la personne sur la carte d\'identité. Prenez la photo selfie dans les mêmes conditions (même personne, même coiffure si possible).',
          },
        };
      }

      this.logger.log(
        `[KYC Validation] ✅ KYC validation SUCCESSFUL - Similarity: ${similarity.toFixed(2)}%`,
      );
      this.logger.log('[KYC Validation] ========================================');

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
      this.logger.error('[KYC Validation] ❌ KYC validation ERROR:', error);
      this.logger.error(`[KYC Validation] Error message: ${error.message}`);
      this.logger.error(`[KYC Validation] Error stack: ${error.stack}`);
      
      // Si c'est déjà une InternalServerErrorException, la relancer telle quelle
      if (error instanceof InternalServerErrorException) {
        this.logger.log('[KYC Validation] ========================================');
        throw error;
      }
      
      // Pour toute autre erreur (AWS, réseau, etc.), lancer une exception pour déclencher la validation manuelle
      this.logger.error('[KYC Validation] Service unavailable - Will fallback to manual review');
      this.logger.log('[KYC Validation] ========================================');
      throw new InternalServerErrorException(
        'ERREUR TECHNIQUE : Le service de validation automatique n\'est pas disponible actuellement. Votre demande sera examinée manuellement par notre équipe.',
      );
    }
  }

  /**
   * Detect faces in an image
   * @param imageBuffer Buffer containing image data
   * @param imageType Type of image (CNI or Selfie) for logging
   * @returns Face detection result
   */
  private async detectFaces(imageBuffer: Buffer, imageType: string = 'Image'): Promise<{
    hasFace: boolean;
    faceCount: number;
    faceQuality: number; // Average quality score of detected faces
  }> {
    if (!this.rekognitionClient) {
      this.logger.error(`[Face Detection] ❌ Rekognition client not available for ${imageType}`);
      // Ce cas ne devrait pas se produire car on vérifie avant d'appeler cette méthode
      // Mais si cela arrive, on lance une exception pour déclencher la validation manuelle
      throw new InternalServerErrorException(
        `ERREUR TECHNIQUE : Service de détection de visage indisponible pour ${imageType}. Validation manuelle requise.`
      );
    }

    try {
      this.logger.debug(`[Face Detection] Sending DetectFaces request for ${imageType} (${imageBuffer.length} bytes)...`);
      
      const command = new DetectFacesCommand({
        Image: {
          Bytes: imageBuffer,
        },
        Attributes: ['ALL'], // ALL includes quality, eyes_open, mouth_open, etc.
      });

      const startTime = Date.now();
      const response: DetectFacesResponse =
        await this.rekognitionClient.send(command);
      const duration = Date.now() - startTime;

      this.logger.debug(`[Face Detection] ${imageType} detection completed in ${duration}ms`);

      const faces = response.FaceDetails || [];
      const faceCount = faces.length;

      this.logger.debug(`[Face Detection] ${imageType}: Found ${faceCount} face(s)`);

      if (faceCount === 0) {
        this.logger.warn(`[Face Detection] ${imageType}: No faces detected`);
        return { hasFace: false, faceCount: 0, faceQuality: 0 };
      }

      // Calculate average quality score
      const totalQuality = faces.reduce((sum, face, index) => {
        const quality = face.Quality;
        if (!quality) {
          this.logger.warn(`[Face Detection] ${imageType}: Face ${index + 1} has no quality data`);
          return sum;
        }
        
        const brightness = quality.Brightness || 0;
        const sharpness = quality.Sharpness || 0;
        // Quality score is a combination of brightness, sharpness, etc.
        const qualityScore = brightness * 0.3 + sharpness * 0.7;
        
        this.logger.debug(
          `[Face Detection] ${imageType} - Face ${index + 1}: Brightness=${brightness.toFixed(2)}, Sharpness=${sharpness.toFixed(2)}, Quality=${qualityScore.toFixed(2)}`,
        );
        
        return sum + qualityScore;
      }, 0);

      const averageQuality = totalQuality / faceCount;
      this.logger.debug(`[Face Detection] ${imageType}: Average quality = ${averageQuality.toFixed(2)}%`);

      return {
        hasFace: true,
        faceCount,
        faceQuality: averageQuality,
      };
    } catch (error) {
      this.logger.error(`[Face Detection] ❌ Error detecting faces in ${imageType}:`, error);
      this.logger.error(`[Face Detection] Error message: ${error.message}`);
      this.logger.error(`[Face Detection] Error code: ${error.name || 'Unknown'}`);
      throw new InternalServerErrorException(`Erreur lors de la détection des visages dans ${imageType}`);
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
      this.logger.error('[Face Comparison] ❌ Rekognition client not available');
      // Ce cas ne devrait pas se produire car on vérifie avant d'appeler cette méthode
      // Mais si cela arrive, on lance une exception pour déclencher la validation manuelle
      throw new InternalServerErrorException(
        'ERREUR TECHNIQUE : Service de comparaison de visages indisponible. Validation manuelle requise.'
      );
    }

    try {
      this.logger.debug(`[Face Comparison] Sending CompareFaces request (CNI: ${sourceImage.length} bytes, Selfie: ${targetImage.length} bytes)...`);
      this.logger.debug(`[Face Comparison] Similarity threshold: ${this.minSimilarity}%`);
      
      const command = new CompareFacesCommand({
        SourceImage: {
          Bytes: sourceImage,
        },
        TargetImage: {
          Bytes: targetImage,
        },
        SimilarityThreshold: this.minSimilarity,
      });

      const startTime = Date.now();
      const response: CompareFacesResponse =
        await this.rekognitionClient.send(command);
      const duration = Date.now() - startTime;

      this.logger.debug(`[Face Comparison] Comparison completed in ${duration}ms`);

      const faceMatches = response.FaceMatches || [];
      const unmatchedFaces = response.UnmatchedFaces || [];

      this.logger.debug(`[Face Comparison] Found ${faceMatches.length} matched face(s), ${unmatchedFaces.length} unmatched face(s)`);

      if (faceMatches.length === 0) {
        this.logger.warn('[Face Comparison] ❌ No face matches found - Similarity: 0%');
        return { similarity: 0 };
      }

      // Get the highest similarity score
      const similarities = faceMatches.map((match) => match.Similarity || 0);
      const maxSimilarity = Math.max(...similarities);
      
      this.logger.debug(`[Face Comparison] Similarity scores: ${similarities.map(s => s.toFixed(2)).join('%, ')}%`);
      this.logger.debug(`[Face Comparison] Maximum similarity: ${maxSimilarity.toFixed(2)}%`);

      return { similarity: maxSimilarity };
    } catch (error) {
      this.logger.error('[Face Comparison] ❌ Error comparing faces:', error);
      this.logger.error(`[Face Comparison] Error message: ${error.message}`);
      this.logger.error(`[Face Comparison] Error code: ${error.name || 'Unknown'}`);
      if (error.$metadata) {
        this.logger.error(`[Face Comparison] AWS Request ID: ${error.$metadata.requestId || 'N/A'}`);
        this.logger.error(`[Face Comparison] AWS HTTP Status: ${error.$metadata.httpStatusCode || 'N/A'}`);
      }
      throw new InternalServerErrorException('Erreur lors de la comparaison des visages');
    }
  }
}

