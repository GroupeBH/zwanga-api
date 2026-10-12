import { Injectable } from '@nestjs/common';
import {
  CompareFacesCommand,
  CreateFaceLivenessSessionCommand,
  DetectFacesCommand,
  GetFaceLivenessSessionResultsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import {
  DetectDocumentTextCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

@Injectable()
export class AwsKycTransport {
  // No SDK retries for metered analysis: the durable worker bounds retries explicitly.
  private readonly clients = new Map<
    string,
    { faces: RekognitionClient; text: TextractClient; sts: STSClient }
  >();
  private client(region: string) {
    if (!this.clients.has(region))
      this.clients.set(region, {
        faces: new RekognitionClient({ region, maxAttempts: 1 }),
        text: new TextractClient({ region, maxAttempts: 1 }),
        sts: new STSClient({ region, maxAttempts: 1 }),
      });
    return this.clients.get(region)!;
  }
  private options() {
    return { abortSignal: AbortSignal.timeout(20_000) };
  }
  async create(region: string, token: string) {
    const result = await this.client(region).faces.send(
      new CreateFaceLivenessSessionCommand({
        ClientRequestToken: token,
        Settings: {
          AuditImagesLimit: 0,
          ChallengePreferences: [{ Type: 'FaceMovementAndLightChallenge' }],
        },
        // No OutputConfig: server retrieves bytes and archives them in the existing private bucket.
      }),
      this.options(),
    );
    if (!result.SessionId) throw new Error('MISSING_SESSION');
    return result.SessionId;
  }
  result(region: string, sessionId: string) {
    return this.client(region).faces.send(
      new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }),
      this.options(),
    );
  }
  async credentials(region: string, roleArn: string, id: string) {
    const result = await this.client(region).sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `kyc-${id}`,
        DurationSeconds: 900,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: 'rekognition:StartFaceLivenessSession',
              Resource: '*',
              Condition: { StringEquals: { 'aws:RequestedRegion': region } },
            },
          ],
        }),
      }),
      this.options(),
    );
    const c = result.Credentials;
    if (
      !c?.AccessKeyId ||
      !c.SecretAccessKey ||
      !c.SessionToken ||
      !c.Expiration
    )
      throw new Error('MISSING_CREDENTIALS');
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration.toISOString(),
    };
  }
  async ocr(region: string, image: Buffer) {
    const result = await this.client(region).text.send(
      new DetectDocumentTextCommand({ Document: { Bytes: image } }),
      this.options(),
    );
    return (result.Blocks ?? [])
      .filter((b) => b.BlockType === 'LINE' && b.Text)
      .slice(0, 500)
      .map((b) => ({
        text: b.Text!.slice(0, 500),
        confidence: b.Confidence ?? 0,
      }));
  }
  async compare(
    region: string,
    document: Buffer,
    reference: Buffer,
    threshold: number,
  ) {
    // Detect on the ID only (DEFAULT, no demographics). Never compare an ID to itself.
    const detected = await this.client(region).faces.send(
      new DetectFacesCommand({
        Image: { Bytes: document },
        Attributes: ['DEFAULT'],
      }),
      this.options(),
    );
    const faces = detected.FaceDetails ?? [];
    if (
      faces.length !== 1 ||
      (faces[0].Confidence ?? 0) < 95 ||
      (faces[0].Quality?.Sharpness ?? 0) < 50 ||
      (faces[0].Quality?.Brightness ?? 0) < 35
    )
      return {
        passed: false,
        similarity: null,
        reason: 'DOCUMENT_FACE_QUALITY',
      };
    const result = await this.client(region).faces.send(
      new CompareFacesCommand({
        SourceImage: { Bytes: document },
        TargetImage: { Bytes: reference },
        SimilarityThreshold: threshold,
        QualityFilter: 'AUTO',
      }),
      this.options(),
    );
    const matches = result.FaceMatches ?? [];
    return {
      passed:
        matches.length === 1 &&
        !result.UnmatchedFaces?.length &&
        (matches[0].Similarity ?? 0) >= threshold,
      similarity: matches[0]?.Similarity ?? null,
      reason: 'FACE_MISMATCH',
    };
  }
}
