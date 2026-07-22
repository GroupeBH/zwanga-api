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
    cniFrontFaces?: number | number[]; // Can be array if multiple CNI images
    selfieFaces?: number;
    similarityScore?: number;
    issue?: string;
    recommendation?: string;
    cniQuality?: number | number[]; // Can be array if multiple CNI images
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
      this.configService.get<string>('AWS_REKOGNITION_KYC_MIN_SIMILARITY') || '40',
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
   * Validate KYC documents by comparing selfie with CNI photo(s)
   * @param cniFrontImages Array of buffers containing CNI front images (1 or 2)
   * @param selfieImage Buffer containing selfie image
   * @returns Validation result
   */
  async validateKyc(
    cniFrontImages: Buffer[],
    selfieImage: Buffer,
  ): Promise<KycValidationResult> {
    this.logger.log('[KYC Validation] ========================================');
    this.logger.log('[KYC Validation] Starting KYC validation process');
    this.logger.log(`[KYC Validation] CNI images count: ${cniFrontImages.length}`);
    cniFrontImages.forEach((img, idx) => {
      this.logger.log(`[KYC Validation] CNI image ${idx + 1} size: ${img.length} bytes`);
    });
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

      // Step 1: Detect faces in all CNI images and selfie
      const cniFaceDetections = await Promise.all(
        cniFrontImages.map((img, idx) => this.detectFaces(img, `CNI-${idx + 1}`))
      );
      const selfieFaceDetection = await this.detectFaces(selfieImage, 'Selfie');

      this.logger.log('[KYC Validation] Step 1 completed:');
      cniFaceDetections.forEach((detection, idx) => {
        this.logger.log(`[KYC Validation]   - CNI-${idx + 1}: ${detection.hasFace ? '✅ Face detected' : '❌ No face'} (${detection.faceCount} face(s), quality: ${detection.faceQuality.toFixed(2)}%)`);
      });
      this.logger.log(`[KYC Validation]   - Selfie: ${selfieFaceDetection.hasFace ? '✅ Face detected' : '❌ No face'} (${selfieFaceDetection.faceCount} face(s), quality: ${selfieFaceDetection.faceQuality.toFixed(2)}%)`);

      // Step 2: Validate face detection in all CNI images
      this.logger.log('[KYC Validation] Step 2: Validating face detection results...');
      const cniWithoutFaces = cniFaceDetections.filter(d => !d.hasFace);
      if (cniWithoutFaces.length > 0) {
        const failedIndices = cniFaceDetections
          .map((d, idx) => !d.hasFace ? idx + 1 : null)
          .filter(idx => idx !== null);
        this.logger.warn(`[KYC Validation] ❌ No face detected in CNI front image(s): ${failedIndices.join(', ')}`);
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
          reason: `ÉCHEC : Aucun visage détecté sur ${failedIndices.length === 1 ? 'la photo' : 'certaines photos'} de la CNI (photo${failedIndices.length > 1 ? 's' : ''} ${failedIndices.join(', ')}). Veuillez prendre une photo claire de votre carte d'identité où votre visage est bien visible.`,
          details: {
            cniFrontFaces: cniFaceDetections.map(d => d.faceCount),
            selfieFaces: selfieFaceDetection.faceCount,
            issue: 'NO_FACE_IN_CNI',
            recommendation: 'Assurez-vous que votre visage est clairement visible sur toutes les photos de la CNI. Évitez les reflets et les ombres.',
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
            cniFrontFaces: cniFaceDetections.map(d => d.faceCount),
            selfieFaces: selfieFaceDetection.faceCount,
            issue: 'NO_FACE_IN_SELFIE',
            recommendation: 'Prenez une photo selfie avec un bon éclairage, face à la caméra, sans masque ni lunettes de soleil.',
          },
        };
      }

      // Step 3: Check if too many faces detected in any CNI image (max 2 faces per image allowed)
      this.logger.log('[KYC Validation] Step 3: Checking face count per CNI image...');
      const cniWithTooManyFaces = cniFaceDetections.filter(d => d.faceCount > 2);
      if (cniWithTooManyFaces.length > 0) {
        const failedIndices = cniFaceDetections
          .map((d, idx) => d.faceCount > 2 ? idx + 1 : null)
          .filter(idx => idx !== null);
        const faceCounts = cniFaceDetections
          .map((d, idx) => d.faceCount > 2 ? `${idx + 1}:${d.faceCount}` : null)
          .filter(s => s !== null);
        this.logger.warn(
          `[KYC Validation] ❌ Too many faces detected in CNI front image(s) (${faceCounts.join(', ')})`,
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
          reason: `ÉCHEC : Trop de visages détectés sur ${failedIndices.length === 1 ? 'la photo' : 'certaines photos'} de la CNI (photo${failedIndices.length > 1 ? 's' : ''} ${failedIndices.join(', ')}). Maximum 2 visages autorisés par photo (par exemple, un passeport avec photo principale et photo secondaire).`,
          details: {
            cniFrontFaces: cniFaceDetections.map(d => d.faceCount),
            selfieFaces: selfieFaceDetection.faceCount,
            issue: 'TOO_MANY_FACES_IN_CNI',
            recommendation: 'Assurez-vous que maximum 2 visages apparaissent sur chaque photo de la carte d\'identité/passeport. Si vous avez plus de 2 visages, veuillez prendre une photo plus claire.',
          },
        };
      }
      
      // Log face counts (1 or 2 faces per CNI image is acceptable)
      cniFaceDetections.forEach((detection, idx) => {
        if (detection.faceCount === 2) {
          this.logger.log(`[KYC Validation]   - CNI-${idx + 1}: 2 visages détectés (sera vérifié qu'ils correspondent à la même personne)`);
        }
      });

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
            cniFrontFaces: cniFaceDetections.map(d => d.faceCount),
            selfieFaces: selfieFaceDetection.faceCount,
            issue: 'MULTIPLE_FACES_IN_SELFIE',
            recommendation: 'Prenez une photo selfie seule, sans autres personnes dans le cadre.',
          },
        };
      }

      // Step 4: Check face quality
      this.logger.log('[KYC Validation] Step 4: Checking face quality...');
      cniFaceDetections.forEach((detection, idx) => {
        this.logger.log(`[KYC Validation]   - CNI-${idx + 1} quality: ${detection.faceQuality.toFixed(2)}% (minimum: ${this.minFaceQuality}%)`);
      });
      this.logger.log(`[KYC Validation]   - Selfie quality: ${selfieFaceDetection.faceQuality.toFixed(2)}% (minimum: ${this.minFaceQuality}%)`);
      
      const lowQualityCni = cniFaceDetections.filter(d => d.faceQuality < this.minFaceQuality);
      if (lowQualityCni.length > 0 || selfieFaceDetection.faceQuality < this.minFaceQuality) {
        const failedIndices = cniFaceDetections
          .map((d, idx) => d.faceQuality < this.minFaceQuality ? idx + 1 : null)
          .filter(idx => idx !== null);
        const qualityDetails = cniFaceDetections
          .map((d, idx) => `CNI-${idx + 1}: ${d.faceQuality.toFixed(1)}%`)
          .join(', ');
        this.logger.warn(
          `[KYC Validation] ❌ Low face quality detected - ${qualityDetails}, Selfie: ${selfieFaceDetection.faceQuality.toFixed(2)}% (minimum: ${this.minFaceQuality}%)`,
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
          reason: `ÉCHEC : Qualité des images insuffisante. ${qualityDetails}, Selfie: ${selfieFaceDetection.faceQuality.toFixed(1)}% (minimum: ${this.minFaceQuality}%).`,
          details: {
            cniFrontFaces: cniFaceDetections.map(d => d.faceCount),
            selfieFaces: selfieFaceDetection.faceCount,
            cniQuality: cniFaceDetections.map(d => d.faceQuality),
            selfieQuality: selfieFaceDetection.faceQuality,
            minRequiredQuality: this.minFaceQuality,
            issue: 'LOW_IMAGE_QUALITY',
            recommendation: 'Prenez des photos avec un bon éclairage, évitez les flous, les reflets et les ombres. Utilisez une caméra de bonne qualité.',
          },
        };
      }

      // Step 5: Compare all CNI faces with selfie and between CNI images
      this.logger.log('[KYC Validation] Step 5: Comparing faces between CNI images and selfie...');
      
      // Compare each CNI image with selfie
      const cniSelfieComparisons = await Promise.all(
        cniFrontImages.map((img, idx) => 
          this.compareFaces(img, selfieImage).then(result => ({
            cniIndex: idx + 1,
            similarity: result.similarity,
          }))
        )
      );

      // If a CNI image has 2 faces, compare them with each other to verify they're the same person
      const cniSameImageComparisons: Array<{ cniIndex: number; similarity: number }> = [];
      for (let i = 0; i < cniFrontImages.length; i++) {
        if (cniFaceDetections[i].faceCount === 2) {
          this.logger.log(`[KYC Validation] CNI-${i + 1} has 2 faces - comparing them to verify same person...`);
          // Compare the image with itself - AWS Rekognition will compare all faces in source with all faces in target
          const comparison = await this.compareFaces(cniFrontImages[i], cniFrontImages[i]);
          cniSameImageComparisons.push({
            cniIndex: i + 1,
            similarity: comparison.similarity,
          });
          this.logger.log(`[KYC Validation]   - CNI-${i + 1} (2 faces): similarity ${comparison.similarity.toFixed(2)}%`);
        }
      }

      // Compare CNI images with each other (if more than one photo)
      let cniCniComparisons: Array<{ cni1: number; cni2: number; similarity: number }> = [];
      if (cniFrontImages.length > 1) {
        this.logger.log('[KYC Validation] Comparing CNI images with each other...');
        for (let i = 0; i < cniFrontImages.length; i++) {
          for (let j = i + 1; j < cniFrontImages.length; j++) {
            const comparison = await this.compareFaces(cniFrontImages[i], cniFrontImages[j]);
            cniCniComparisons.push({
              cni1: i + 1,
              cni2: j + 1,
              similarity: comparison.similarity,
            });
          }
        }
      }

      // Find minimum similarity scores
      const minCniSelfieSimilarity = Math.min(...cniSelfieComparisons.map(c => c.similarity));
      const minCniSameImageSimilarity = cniSameImageComparisons.length > 0
        ? Math.min(...cniSameImageComparisons.map(c => c.similarity))
        : 100; // If no CNI image has 2 faces, consider it as matching
      const minCniCniSimilarity = cniCniComparisons.length > 0 
        ? Math.min(...cniCniComparisons.map(c => c.similarity))
        : 100; // If only one CNI image, consider it as matching itself

      // All comparisons must pass
      const allCniSelfieMatch = cniSelfieComparisons.every(c => c.similarity >= this.minSimilarity);
      const allCniSameImageMatch = cniSameImageComparisons.length === 0 || cniSameImageComparisons.every(c => c.similarity >= this.minSimilarity);
      const allCniCniMatch = cniCniComparisons.length === 0 || cniCniComparisons.every(c => c.similarity >= this.minSimilarity);
      const matched = allCniSelfieMatch && allCniSameImageMatch && allCniCniMatch;

      this.logger.log(`[KYC Validation] Face comparison results:`);
      cniSelfieComparisons.forEach(c => {
        this.logger.log(`[KYC Validation]   - CNI-${c.cniIndex} vs Selfie: ${c.similarity.toFixed(2)}% ${c.similarity >= this.minSimilarity ? '✅' : '❌'}`);
      });
      if (cniSameImageComparisons.length > 0) {
        cniSameImageComparisons.forEach(c => {
          this.logger.log(`[KYC Validation]   - CNI-${c.cniIndex} (2 faces internal): ${c.similarity.toFixed(2)}% ${c.similarity >= this.minSimilarity ? '✅' : '❌'}`);
        });
      }
      if (cniCniComparisons.length > 0) {
        cniCniComparisons.forEach(c => {
          this.logger.log(`[KYC Validation]   - CNI-${c.cni1} vs CNI-${c.cni2}: ${c.similarity.toFixed(2)}% ${c.similarity >= this.minSimilarity ? '✅' : '❌'}`);
        });
      }
      this.logger.log(`[KYC Validation]   - Minimum required: ${this.minSimilarity}%`);
      this.logger.log(`[KYC Validation]   - Overall match: ${matched ? '✅ PASSED' : '❌ FAILED'}`);

      if (!matched) {
        const failedComparisons: string[] = [];
        cniSelfieComparisons.forEach(c => {
          if (c.similarity < this.minSimilarity) {
            failedComparisons.push(`CNI-${c.cniIndex} vs Selfie: ${c.similarity.toFixed(1)}%`);
          }
        });
        cniSameImageComparisons.forEach(c => {
          if (c.similarity < this.minSimilarity) {
            failedComparisons.push(`CNI-${c.cniIndex} (2 faces): ${c.similarity.toFixed(1)}%`);
          }
        });
        cniCniComparisons.forEach(c => {
          if (c.similarity < this.minSimilarity) {
            failedComparisons.push(`CNI-${c.cni1} vs CNI-${c.cni2}: ${c.similarity.toFixed(1)}%`);
          }
        });

        this.logger.warn(
          `[KYC Validation] ❌ Face comparison failed - Failed comparisons: ${failedComparisons.join(', ')}`,
        );
        
        const minSimilarity = Math.min(
          minCniSelfieSimilarity,
          minCniSameImageSimilarity,
          minCniCniSimilarity
        );
        
        let reasonMessage = `ÉCHEC : Les visages ne correspondent pas. ${failedComparisons.length === 1 ? 'La comparaison' : 'Certaines comparaisons'} ${failedComparisons.length === 1 ? 'a échoué' : 'ont échoué'} (minimum requis: ${this.minSimilarity}%).`;
        if (cniSameImageComparisons.some(c => c.similarity < this.minSimilarity)) {
          reasonMessage += ' Les 2 visages détectés sur une photo CNI ne correspondent pas à la même personne.';
        }
        reasonMessage += ' Toutes les photos CNI doivent être de la même personne et correspondre au selfie.';
        
        return {
          isValid: false,
          faceMatch: {
            similarity: minSimilarity,
            matched: false,
          },
          faceDetection: {
            cniFront: true,
            selfie: true,
          },
          reason: reasonMessage,
          details: {
            cniFrontFaces: cniFaceDetections.map(d => d.faceCount),
            selfieFaces: selfieFaceDetection.faceCount,
            similarityScore: minSimilarity,
            minRequiredSimilarity: this.minSimilarity,
            issue: 'FACE_MISMATCH',
            recommendation: 'Assurez-vous que toutes les photos CNI sont de la même personne et que le selfie correspond à la personne sur la carte d\'identité/passeport. Si votre document a 2 photos, elles doivent être de la même personne.',
          },
        };
      }

      const avgSimilarity = (
        cniSelfieComparisons.reduce((sum, c) => sum + c.similarity, 0) +
        cniSameImageComparisons.reduce((sum, c) => sum + c.similarity, 0) +
        cniCniComparisons.reduce((sum, c) => sum + c.similarity, 0)
      ) / (cniSelfieComparisons.length + cniSameImageComparisons.length + cniCniComparisons.length || 1);

      this.logger.log(
        `[KYC Validation] ✅ KYC validation SUCCESSFUL - Average similarity: ${avgSimilarity.toFixed(2)}%`,
      );
      this.logger.log('[KYC Validation] ========================================');

      return {
        isValid: true,
        faceMatch: {
          similarity: avgSimilarity,
          matched: true,
        },
        faceDetection: {
          cniFront: true,
          selfie: true,
        },
        details: {
          cniFrontFaces: cniFaceDetections.map(d => d.faceCount),
          selfieFaces: selfieFaceDetection.faceCount,
          similarityScore: avgSimilarity,
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
    } catch (error: any) {
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

