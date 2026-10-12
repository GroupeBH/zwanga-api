import {
  CompareFacesCommand,
  CreateFaceLivenessSessionCommand,
  DetectFacesCommand,
  GetFaceLivenessSessionResultsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import { STSClient } from '@aws-sdk/client-sts';
import {
  DetectDocumentTextCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { AwsKycTransport } from './aws-kyc.transport';

describe('AWS KYC transport contracts (no AWS requests)', () => {
  let faces: jest.SpyInstance, text: jest.SpyInstance, sts: jest.SpyInstance;
  let transport: AwsKycTransport;
  beforeEach(() => {
    faces = jest
      .spyOn(RekognitionClient.prototype, 'send')
      .mockImplementation(jest.fn());
    text = jest
      .spyOn(TextractClient.prototype, 'send')
      .mockImplementation(jest.fn());
    sts = jest.spyOn(STSClient.prototype, 'send').mockImplementation(jest.fn());
    transport = new AwsKycTransport();
  });
  afterEach(() => jest.restoreAllMocks());

  it('creates an idempotent strong-challenge session without external/public output', async () => {
    faces.mockResolvedValue({ SessionId: 'aws-id' });
    expect(await transport.create('eu-west-1', 'stable-request')).toBe(
      'aws-id',
    );
    const [command, options] = faces.mock.calls[0];
    expect(command).toBeInstanceOf(CreateFaceLivenessSessionCommand);
    expect(command.input).toEqual({
      ClientRequestToken: 'stable-request',
      Settings: {
        AuditImagesLimit: 0,
        ChallengePreferences: [{ Type: 'FaceMovementAndLightChallenge' }],
      },
    });
    expect(options.abortSignal).toBeDefined();
    await expect(
      (faces.mock.instances[0] as RekognitionClient).config.maxAttempts(),
    ).resolves.toBe(1);
  });

  it('retrieves results using only the server-recorded session', async () => {
    faces.mockResolvedValue({ SessionId: 'aws-id', Status: 'IN_PROGRESS' });
    await transport.result('eu-west-1', 'aws-id');
    expect(faces.mock.calls[0][0]).toBeInstanceOf(
      GetFaceLivenessSessionResultsCommand,
    );
    expect(faces.mock.calls[0][0].input).toEqual({ SessionId: 'aws-id' });
  });

  it('gives the phone temporary capture-only regional credentials', async () => {
    sts.mockResolvedValue({
      Credentials: {
        AccessKeyId: 'test-key',
        SecretAccessKey: 'test-secret',
        SessionToken: 'test-token',
        Expiration: new Date('2030-01-01T00:15:00Z'),
      },
    });
    const result = await transport.credentials(
      'eu-west-1',
      'scoped-role',
      'internal-id',
    );
    const input = sts.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('scoped-role');
    expect(input.DurationSeconds).toBe(900);
    expect(JSON.parse(input.Policy).Statement).toEqual([
      {
        Effect: 'Allow',
        Action: 'rekognition:StartFaceLivenessSession',
        Resource: '*',
        Condition: { StringEquals: { 'aws:RequestedRegion': 'eu-west-1' } },
      },
    ]);
    expect(result.expiration).toBe('2030-01-01T00:15:00.000Z');
    sts.mockResolvedValue({ Credentials: { AccessKeyId: 'incomplete' } });
    await expect(
      transport.credentials('eu-west-1', 'scoped-role', 'id'),
    ).rejects.toThrow('MISSING_CREDENTIALS');
  });

  it('uses generic document text, not unsupported AnalyzeID or demographic analysis', async () => {
    text.mockResolvedValue({
      Blocks: [
        { BlockType: 'LINE', Text: 'Nom: Test', Confidence: 98 },
        { BlockType: 'WORD', Text: 'ignored', Confidence: 99 },
      ],
    });
    expect(await transport.ocr('eu-west-1', Buffer.from('doc'))).toEqual([
      { text: 'Nom: Test', confidence: 98 },
    ]);
    expect(text.mock.calls[0][0]).toBeInstanceOf(DetectDocumentTextCommand);
  });

  const portrait = {
    Confidence: 99,
    Quality: { Sharpness: 90, Brightness: 70 },
  };
  it.each([
    { FaceDetails: [] },
    { FaceDetails: [portrait, portrait] },
    {
      FaceDetails: [
        { ...portrait, Quality: { Sharpness: 10, Brightness: 10 } },
      ],
    },
  ])(
    'stops before comparison when the document portrait is absent, ambiguous or poor quality: %j',
    async ({ FaceDetails }) => {
      faces.mockResolvedValue({ FaceDetails });
      expect(
        (
          await transport.compare(
            'eu-west-1',
            Buffer.from('doc'),
            Buffer.from('aws-frame'),
            95,
          )
        ).passed,
      ).toBe(false);
      expect(faces).toHaveBeenCalledTimes(1);
      expect(faces.mock.calls[0][0]).toBeInstanceOf(DetectFacesCommand);
      expect(faces.mock.calls[0][0].input.Attributes).toEqual(['DEFAULT']);
    },
  );

  it('compares the document against the AWS frame at the server threshold', async () => {
    faces
      .mockResolvedValueOnce({ FaceDetails: [portrait] })
      .mockResolvedValueOnce({
        FaceMatches: [{ Similarity: 99 }],
        UnmatchedFaces: [],
      });
    const document = Buffer.from('doc'),
      frame = Buffer.from('aws-frame');
    expect(
      (await transport.compare('eu-west-1', document, frame, 95)).passed,
    ).toBe(true);
    const command = faces.mock.calls[1][0];
    expect(command).toBeInstanceOf(CompareFacesCommand);
    expect(command.input).toEqual({
      SourceImage: { Bytes: document },
      TargetImage: { Bytes: frame },
      SimilarityThreshold: 95,
      QualityFilter: 'AUTO',
    });
  });

  it.each([
    { FaceMatches: [] },
    { FaceMatches: [{ Similarity: 80 }] },
    { FaceMatches: [{ Similarity: 99 }, { Similarity: 98 }] },
    { FaceMatches: [{ Similarity: 99 }], UnmatchedFaces: [{}] },
  ])(
    'rejects inadequate or ambiguous comparison results: %j',
    async (response) => {
      faces
        .mockResolvedValueOnce({ FaceDetails: [portrait] })
        .mockResolvedValueOnce(response);
      expect(
        (
          await transport.compare(
            'eu-west-1',
            Buffer.from('doc'),
            Buffer.from('frame'),
            95,
          )
        ).passed,
      ).toBe(false);
    },
  );
});
