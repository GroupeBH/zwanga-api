import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import {
  CreateDiditKycSessionDto,
  SyncDiditKycSessionDto,
} from './dto/user.dto';
import {
  KycDocument,
  KycProvider,
  KycStatus,
} from './entities/kyc-document.entity';
import { User, UserStatus } from './entities/user.entity';

type DiditHttpMethod = 'GET' | 'POST';
type DiditPayload = Record<string, unknown>;

type DiditSessionResponse = {
  id?: string | null;
  session_id?: string | null;
  sessionId?: string | null;
  verification_session_id?: string | null;
  session_number?: number | null;
  sessionNumber?: number | null;
  session_token?: string | null;
  sessionToken?: string | null;
  url?: string | null;
  verification_url?: string | null;
  status?: string | null;
  vendor_data?: string | null;
  vendorData?: string | null;
  workflow_id?: string | null;
  workflowId?: string | null;
  decision?: unknown;
  data?: unknown;
};

type DiditKycSessionResult = {
  sessionId: string;
  session_id: string;
  sessionNumber: number | null;
  session_number: number | null;
  sessionToken: string | null;
  session_token: string | null;
  url: string;
  verification_url: string;
  status: string | null;
  vendorData: string | null;
  vendor_data: string | null;
  workflowId: string | null;
  workflow_id: string | null;
};

type DiditWebhookHandlingResult = {
  received: true;
  ignored?: boolean;
  reason?: string;
  userId?: string;
  kycId?: string;
  status?: KycStatus;
};

type DiditWebhookSignatureVerification = {
  method: 'v2' | 'simple' | 'bypassed';
};

const DIDIT_API_ORIGIN = 'https://verification.didit.me';
const DIDIT_SIGNATURE_TOLERANCE_SECONDS = 300;

@Injectable()
export class DiditKycService {
  private readonly logger = new Logger(DiditKycService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private readonly kycDocumentRepository: Repository<KycDocument>,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async createSession(
    userId: string,
    dto: CreateDiditKycSessionDto,
  ): Promise<DiditKycSessionResult> {
    const config = this.getRequiredDiditApiConfig();
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouve');
    }

    const existingKyc = await this.findLatestUserKyc(userId);

    if (existingKyc?.status === KycStatus.APPROVED) {
      throw new BadRequestException(
        "Votre identite est deja verifiee. Contactez le support si une nouvelle verification est necessaire.",
      );
    }

    const payload = this.buildCreateSessionPayload(user, dto, config.workflowId);
    const diditSession = await this.diditRequest<DiditSessionResponse>(
      'POST',
      '/v3/session/',
      config.apiKey,
      payload,
      config.baseUrl,
    );

    const sessionId = this.extractSessionId(diditSession);
    const verificationUrl = this.extractSessionUrl(diditSession);
    const sessionToken = this.asNullableString(
      diditSession.sessionToken ?? diditSession.session_token,
    );

    if (!sessionId || (!verificationUrl && !sessionToken)) {
      this.logger.error(
        `Didit session creation returned an incomplete payload for user ${userId}`,
      );
      throw new InternalServerErrorException(
        "Didit n'a pas retourne une session exploitable. Veuillez reessayer.",
      );
    }

    await this.applyDiditState({
      userId,
      existingKyc,
      sessionId,
      payload: diditSession,
      source: 'session_created',
      fallbackStatus: diditSession.status ?? 'Not Started',
    });

    return {
      sessionId,
      session_id: sessionId,
      sessionNumber: this.extractSessionNumber(diditSession),
      session_number: this.extractSessionNumber(diditSession),
      sessionToken,
      session_token: sessionToken,
      url: verificationUrl ?? '',
      verification_url: verificationUrl ?? '',
      status: this.asNullableString(diditSession.status),
      vendorData: this.extractVendorData(diditSession) ?? userId,
      vendor_data: this.extractVendorData(diditSession) ?? userId,
      workflowId: this.extractWorkflowId(diditSession) ?? config.workflowId,
      workflow_id: this.extractWorkflowId(diditSession) ?? config.workflowId,
    };
  }

  async syncSession(
    userId: string,
    dto: SyncDiditKycSessionDto,
  ): Promise<KycDocument | null> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('Utilisateur non trouve');
    }

    const sessionId = this.asNullableString(dto.sessionId);
    let existingKyc = sessionId
      ? await this.findKycForSessionAndUser(sessionId, userId)
      : await this.findLatestUserKyc(userId);
    const effectiveSessionId = sessionId ?? existingKyc?.diditSessionId ?? null;

    if (!effectiveSessionId) {
      return existingKyc ?? null;
    }

    const config = this.getOptionalDiditApiConfig();

    if (!config) {
      this.logger.warn(
        `Didit sync requested for user ${userId}, but Didit API is not configured. Keeping the local KYC status unchanged.`,
      );
      return existingKyc ?? null;
    }

    const diditSession = await this.retrieveSessionDecision(
      effectiveSessionId,
      config.apiKey,
      config.baseUrl,
    );

    const diditVendorData = this.extractVendorData(diditSession);
    if (sessionId && !existingKyc && diditVendorData !== userId) {
      throw new ForbiddenException(
        "Cette session Didit n'est pas rattachee a votre compte Zwanga.",
      );
    }

    if (!existingKyc) {
      existingKyc = await this.findLatestUserKyc(userId);
    }

    return this.applyDiditState({
      userId,
      existingKyc,
      sessionId: effectiveSessionId,
      payload: diditSession,
      source: 'sync',
      fallbackStatus: dto.status,
    });
  }

  async handleWebhook(
    headers: Record<string, string | string[] | undefined>,
    payload: DiditPayload,
  ): Promise<DiditWebhookHandlingResult> {
    const signatureVerification = this.verifyWebhookSignature(headers, payload);

    const eventPayload = this.unwrapDiditPayload(payload);
    const sessionId = this.extractSessionId(eventPayload);
    const vendorData =
      signatureVerification.method === 'simple'
        ? null
        : this.extractVendorData(eventPayload);

    if (!sessionId && !vendorData) {
      this.logger.warn(
        'Didit webhook ignored because it does not contain session_id or vendor_data',
      );
      return {
        received: true,
        ignored: true,
        reason: 'missing_session_and_vendor_data',
      };
    }

    const existingKyc = sessionId
      ? await this.kycDocumentRepository.findOne({
          where: { diditSessionId: sessionId },
        })
      : null;

    if (signatureVerification.method === 'simple' && !existingKyc) {
      this.logger.warn(
        `Didit webhook ignored because X-Signature-Simple was used and session ${sessionId} is not mapped locally`,
      );
      return {
        received: true,
        ignored: true,
        reason: 'simple_signature_without_local_session',
      };
    }

    const userId = existingKyc?.userId ?? vendorData;

    if (!userId) {
      return {
        received: true,
        ignored: true,
        reason: 'missing_user_id',
      };
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      this.logger.warn(
        `Didit webhook ignored because user ${userId} does not exist`,
      );
      return {
        received: true,
        ignored: true,
        reason: 'unknown_user',
      };
    }

    let diditSession = eventPayload;
    const config = this.getOptionalDiditApiConfig();

    if (sessionId && config) {
      try {
        diditSession = await this.retrieveSessionDecision(
          sessionId,
          config.apiKey,
          config.baseUrl,
        );
      } catch (error) {
        this.logger.warn(
          `Didit webhook could not refresh session ${sessionId}; applying signed webhook payload. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const savedKyc = await this.applyDiditState({
      userId: user.id,
      existingKyc,
      sessionId,
      payload: diditSession,
      source: 'webhook',
      fallbackStatus: this.asNullableString(eventPayload.status),
    });

    return {
      received: true,
      userId: user.id,
      kycId: savedKyc.id,
      status: savedKyc.status,
    };
  }

  private buildCreateSessionPayload(
    user: User,
    dto: CreateDiditKycSessionDto,
    workflowId: string,
  ): DiditPayload {
    const language = dto.language?.trim() || 'fr';
    const callbackUrl = dto.callbackUrl?.trim();
    const payload: DiditPayload = {
      workflow_id: workflowId,
      vendor_data: user.id,
      language,
      metadata: {
        source: dto.source?.trim() || 'zwanga-app',
        zwangaUserId: user.id,
        requestedAt: new Date().toISOString(),
      },
    };

    if (callbackUrl) {
      payload.callback = callbackUrl;
      payload.callback_url = callbackUrl;
      payload.redirect_url = callbackUrl;
    }

    const expectedDetails: Record<string, string> = {};
    if (user.firstName) {
      expectedDetails.first_name = user.firstName;
    }
    if (user.lastName) {
      expectedDetails.last_name = user.lastName;
    }
    if (Object.keys(expectedDetails).length > 0) {
      payload.expected_details = expectedDetails;
    }

    const contactDetails: Record<string, string> = {};
    if (user.phone) {
      contactDetails.phone = user.phone;
    }
    if (user.email) {
      contactDetails.email = user.email;
    }
    if (Object.keys(contactDetails).length > 0) {
      payload.contact_details = contactDetails;
    }

    return payload;
  }

  private async retrieveSessionDecision(
    sessionId: string,
    apiKey: string,
    baseUrl: string,
  ): Promise<DiditSessionResponse> {
    return this.diditRequest<DiditSessionResponse>(
      'GET',
      `/v3/session/${encodeURIComponent(sessionId)}/decision/`,
      apiKey,
      undefined,
      baseUrl,
    );
  }

  private async diditRequest<T>(
    method: DiditHttpMethod,
    path: string,
    apiKey: string,
    payload: DiditPayload | undefined,
    baseUrl: string,
  ): Promise<T> {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${normalizedBaseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(20_000),
    });

    const responseText = await response.text();
    let responsePayload: unknown = null;

    if (responseText) {
      try {
        responsePayload = JSON.parse(responseText);
      } catch {
        responsePayload = { message: responseText };
      }
    }

    if (!response.ok) {
      const message = this.extractErrorMessage(responsePayload);
      this.logger.error(
        `Didit API ${method} ${path} failed with HTTP ${response.status}: ${message}`,
      );
      throw new BadRequestException(
        message || "Didit n'a pas accepte la demande de verification.",
      );
    }

    return this.unwrapDiditPayload(responsePayload as DiditPayload) as T;
  }

  private async applyDiditState(input: {
    userId: string;
    existingKyc?: KycDocument | null;
    sessionId?: string | null;
    payload: DiditSessionResponse | DiditPayload;
    source: 'session_created' | 'sync' | 'webhook';
    fallbackStatus?: string | null;
  }): Promise<KycDocument> {
    const diditPayload = this.unwrapDiditPayload(input.payload as DiditPayload);
    const sessionId = input.sessionId ?? this.extractSessionId(diditPayload);
    const diditVendorData = this.extractVendorData(diditPayload);
    const statusText =
      this.asNullableString(diditPayload.status) ?? input.fallbackStatus ?? null;
    const mappedStatus = this.mapDiditStatus(statusText);
    const now = new Date();

    if (diditVendorData && diditVendorData !== input.userId) {
      throw new ForbiddenException(
        "Cette session Didit n'est pas rattachee a votre compte Zwanga.",
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const userRepository = manager.getRepository(User);
      const kycRepository = manager.getRepository(KycDocument);

      const user = await userRepository.findOne({
        where: { id: input.userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!user) {
        throw new NotFoundException('Utilisateur non trouve');
      }

      let kycDocument: KycDocument | null = null;

      if (input.existingKyc?.id) {
        kycDocument = await kycRepository.findOne({
          where: { id: input.existingKyc.id },
          lock: { mode: 'pessimistic_write' },
        });
      }

      if (!kycDocument && sessionId) {
        kycDocument = await kycRepository.findOne({
          where: { diditSessionId: sessionId },
          lock: { mode: 'pessimistic_write' },
        });
      }

      if (!kycDocument) {
        kycDocument = await kycRepository.findOne({
          where: { userId: input.userId },
          order: { createdAt: 'DESC' },
          lock: { mode: 'pessimistic_write' },
        });
      }

      if (kycDocument && kycDocument.userId !== input.userId) {
        throw new ForbiddenException(
          'Cette session KYC Didit appartient a un autre utilisateur.',
        );
      }

      if (!kycDocument) {
        kycDocument = kycRepository.create({
          userId: input.userId,
          user,
          status: KycStatus.PENDING,
          provider: KycProvider.DIDIT,
        });
      }

      const isStalePendingEvent =
        Boolean(sessionId) &&
        Boolean(kycDocument.diditSessionId) &&
        kycDocument.diditSessionId !== sessionId &&
        mappedStatus === KycStatus.PENDING &&
        kycDocument.status !== KycStatus.PENDING;

      kycDocument.provider = KycProvider.DIDIT;
      kycDocument.diditSessionId = sessionId ?? kycDocument.diditSessionId;
      kycDocument.diditSessionNumber =
        this.extractSessionNumber(diditPayload) ??
        kycDocument.diditSessionNumber ??
        null;
      kycDocument.diditWorkflowId =
        this.extractWorkflowId(diditPayload) ?? kycDocument.diditWorkflowId;
      kycDocument.diditVendorData = diditVendorData ?? kycDocument.diditVendorData;
      kycDocument.diditSessionStatus = statusText;
      kycDocument.diditLastSyncedAt = now;
      kycDocument.providerMetadata = this.sanitizeDiditPayloadForStorage(
        diditPayload,
        input.source,
      );

      if (!isStalePendingEvent) {
        kycDocument.status = mappedStatus;
        kycDocument.rejectionReason =
          mappedStatus === KycStatus.REJECTED
            ? this.extractRejectionReason(statusText, diditPayload)
            : null;
      }

      const savedKyc = await kycRepository.save(kycDocument);

      if (mappedStatus === KycStatus.APPROVED && !isStalePendingEvent) {
        if (user.status !== UserStatus.SUSPENDED) {
          user.status = UserStatus.ACTIVE;
          await userRepository.save(user);
        }
      } else if (
        [KycStatus.PENDING, KycStatus.REJECTED].includes(savedKyc.status) &&
        user.status !== UserStatus.SUSPENDED
      ) {
        user.status = UserStatus.PENDING_KYC;
        await userRepository.save(user);
      }

      return savedKyc;
    });
  }

  private findLatestUserKyc(userId: string): Promise<KycDocument | null> {
    return this.kycDocumentRepository.findOne({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  private async findKycForSessionAndUser(
    sessionId: string,
    userId: string,
  ): Promise<KycDocument | null> {
    const bySession = await this.kycDocumentRepository.findOne({
      where: { diditSessionId: sessionId },
    });

    if (bySession) {
      if (bySession.userId !== userId) {
        throw new ForbiddenException(
          'Cette session KYC Didit appartient a un autre utilisateur.',
        );
      }
      return bySession;
    }

    return null;
  }

  private getRequiredDiditApiConfig(): {
    apiKey: string;
    workflowId: string;
    baseUrl: string;
  } {
    const config = this.getOptionalDiditApiConfig();

    if (!config?.apiKey || !config.workflowId) {
      throw new UnauthorizedException(
        "La verification Didit n'est pas configuree.",
      );
    }

    return config;
  }

  private getOptionalDiditApiConfig():
    | {
        apiKey: string;
        workflowId: string;
        baseUrl: string;
      }
    | null {
    const enabled =
      this.configService.get<string>('DIDIT_KYC_ENABLED') === 'true' ||
      this.configService.get<string>('KYC_PROVIDER') === 'didit';

    if (!enabled) {
      return null;
    }

    const apiKey =
      this.configService.get<string>('DIDIT_API_KEY') ||
      this.configService.get<string>('DIDIT_KYC_API_KEY');
    const workflowId =
      this.configService.get<string>('DIDIT_WORKFLOW_ID') ||
      this.configService.get<string>('DIDIT_KYC_WORKFLOW_ID');
    if (!apiKey || !workflowId) {
      return null;
    }

    return {
      apiKey,
      workflowId,
      baseUrl: DIDIT_API_ORIGIN,
    };
  }

  private verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    payload: DiditPayload,
  ): DiditWebhookSignatureVerification {
    const requireSignature =
      this.configService.get<string>('DIDIT_WEBHOOK_REQUIRE_SIGNATURE') !==
      'false';
    const secret =
      this.configService.get<string>('DIDIT_WEBHOOK_SECRET') ||
      this.configService.get<string>('DIDIT_KYC_WEBHOOK_SECRET');

    if (!secret) {
      if (requireSignature) {
        throw new UnauthorizedException(
          "Le secret webhook Didit n'est pas configure.",
        );
      }
      this.logger.warn(
        'Didit webhook signature check bypassed because DIDIT_WEBHOOK_REQUIRE_SIGNATURE=false.',
      );
      return { method: 'bypassed' };
    }

    const signature = this.getHeader(headers, 'x-signature-v2');
    const signatureSimple = this.getHeader(headers, 'x-signature-simple');
    const timestamp = this.getHeader(headers, 'x-timestamp');

    if ((!signature && !signatureSimple) || !timestamp) {
      throw new UnauthorizedException('Webhook Didit non signe.');
    }

    const toleranceSeconds =
      Number(
        this.configService.get<string>('DIDIT_WEBHOOK_TOLERANCE_SECONDS'),
      ) || DIDIT_SIGNATURE_TOLERANCE_SECONDS;
    const timestampMs = this.parseWebhookTimestamp(timestamp);

    if (
      !timestampMs ||
      Math.abs(Date.now() - timestampMs) > toleranceSeconds * 1000
    ) {
      throw new UnauthorizedException('Webhook Didit expire.');
    }

    const canonicalPayload = this.canonicalJson(payload);
    const expectedHex = createHmac('sha256', secret)
      .update(canonicalPayload)
      .digest('hex');
    const expectedBase64 = createHmac('sha256', secret)
      .update(canonicalPayload)
      .digest('base64');

    if (
      signature &&
      (this.safeCompareSignature(signature, expectedHex) ||
        this.safeCompareSignature(signature, expectedBase64))
    ) {
      return { method: 'v2' };
    }

    if (signatureSimple && this.verifySimpleSignature(payload, signatureSimple, timestamp, secret)) {
      return { method: 'simple' };
    }

    throw new UnauthorizedException('Signature webhook Didit invalide.');
  }

  private verifySimpleSignature(
    payload: DiditPayload,
    signature: string,
    fallbackTimestamp: string,
    secret: string,
  ): boolean {
    const eventPayload = this.unwrapDiditPayload(payload);
    const signedTimestamp =
      this.asNullableString(eventPayload.timestamp) ?? fallbackTimestamp;
    const sessionId = this.extractSessionId(eventPayload) ?? '';
    const status = this.asNullableString(eventPayload.status) ?? '';
    const webhookType =
      this.asNullableString(eventPayload.webhook_type ?? eventPayload.webhookType) ??
      '';
    const canonicalString = [
      signedTimestamp,
      sessionId,
      status,
      webhookType,
    ].join(':');
    const expectedHex = createHmac('sha256', secret)
      .update(canonicalString)
      .digest('hex');

    return this.safeCompareSignature(signature, expectedHex);
  }

  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | null {
    const direct = headers[name] ?? headers[name.toLowerCase()];
    const value = Array.isArray(direct) ? direct[0] : direct;
    return value ? String(value).trim() : null;
  }

  private parseWebhookTimestamp(timestamp: string): number | null {
    const numeric = Number(timestamp);

    if (Number.isFinite(numeric)) {
      return timestamp.length >= 13 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private safeCompareSignature(provided: string, expected: string): boolean {
    const normalizedProvided = provided.replace(/^sha256=/i, '').trim();

    try {
      const providedBuffer = Buffer.from(normalizedProvided);
      const expectedBuffer = Buffer.from(expected);

      return (
        providedBuffer.length === expectedBuffer.length &&
        timingSafeEqual(providedBuffer, expectedBuffer)
      );
    } catch {
      return false;
    }
  }

  private canonicalJson(payload: unknown): string {
    return JSON.stringify(this.sortJsonValue(payload));
  }

  private sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortJsonValue(item));
    }

    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          const item = (value as Record<string, unknown>)[key];
          if (item !== undefined) {
            result[key] = this.sortJsonValue(item);
          }
          return result;
        }, {});
    }

    return value;
  }

  private unwrapDiditPayload(payload: unknown): DiditPayload {
    if (!payload || typeof payload !== 'object') {
      return {};
    }

    const objectPayload = payload as DiditPayload;
    const nestedData = objectPayload.data;

    if (
      nestedData &&
      typeof nestedData === 'object' &&
      !Array.isArray(nestedData)
    ) {
      return nestedData as DiditPayload;
    }

    return objectPayload;
  }

  private mapDiditStatus(status?: string | null): KycStatus {
    const normalized = this.normalizeStatus(status);

    if (['approved', 'accept', 'accepted'].includes(normalized)) {
      return KycStatus.APPROVED;
    }

    if (
      [
        'declined',
        'rejected',
        'reject',
        'expired',
        'abandoned',
        'kyc expired',
      ].includes(normalized)
    ) {
      return KycStatus.REJECTED;
    }

    return KycStatus.PENDING;
  }

  private normalizeStatus(status?: string | null): string {
    return String(status ?? '')
      .trim()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private extractSessionId(
    payload: DiditSessionResponse | DiditPayload,
  ): string | null {
    return this.asNullableString(
      payload.sessionId ??
        payload.session_id ??
        payload.verification_session_id ??
        payload.id,
    );
  }

  private extractSessionNumber(
    payload: DiditSessionResponse | DiditPayload,
  ): number | null {
    const value = payload.sessionNumber ?? payload.session_number;
    const numeric = Number(value);

    return Number.isFinite(numeric) ? numeric : null;
  }

  private extractSessionUrl(payload: DiditSessionResponse): string | null {
    return this.asNullableString(payload.url ?? payload.verification_url);
  }

  private extractVendorData(
    payload: DiditSessionResponse | DiditPayload,
  ): string | null {
    return this.asNullableString(payload.vendorData ?? payload.vendor_data);
  }

  private extractWorkflowId(
    payload: DiditSessionResponse | DiditPayload,
  ): string | null {
    return this.asNullableString(payload.workflowId ?? payload.workflow_id);
  }

  private asNullableString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private extractErrorMessage(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const objectPayload = payload as Record<string, unknown>;
    const candidates = [
      objectPayload.message,
      objectPayload.detail,
      objectPayload.error,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
      if (Array.isArray(candidate) && candidate.length > 0) {
        return candidate.map((item) => String(item)).join(', ');
      }
    }

    return null;
  }

  private extractRejectionReason(
    status: string | null,
    payload: DiditPayload,
  ): string {
    const directCandidates = [
      payload.reason,
      payload.decline_reason,
      payload.declined_reason,
      payload.rejection_reason,
      payload.error_message,
    ];

    for (const candidate of directCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    const arrayCandidates = [payload.reasons, payload.decline_reasons];
    for (const candidate of arrayCandidates) {
      if (Array.isArray(candidate) && candidate.length > 0) {
        return candidate.map((item) => String(item)).join(', ');
      }
    }

    const label = status || 'rejetee';
    return `Didit n'a pas valide cette verification d'identite. Statut recu : ${label}.`;
  }

  private sanitizeDiditPayloadForStorage(
    payload: DiditPayload,
    source: string,
  ): Record<string, unknown> {
    const decision =
      payload.decision && typeof payload.decision === 'object'
        ? (payload.decision as Record<string, unknown>)
        : null;

    return {
      source,
      sessionId: this.extractSessionId(payload),
      sessionNumber: this.extractSessionNumber(payload),
      status: this.asNullableString(payload.status),
      vendorData: this.extractVendorData(payload),
      workflowId: this.extractWorkflowId(payload),
      webhookType: this.asNullableString(
        payload.webhook_type ?? payload.webhookType,
      ),
      syncedAt: new Date().toISOString(),
      decisionSummary: decision
        ? {
            status: this.asNullableString(decision.status),
            kyc: this.extractNestedStatus(decision, 'kyc'),
            aml: this.extractNestedStatus(decision, 'aml'),
            liveness: this.extractNestedStatus(decision, 'liveness'),
            document: this.extractNestedStatus(decision, 'document'),
          }
        : null,
    };
  }

  private extractNestedStatus(
    payload: Record<string, unknown>,
    key: string,
  ): string | null {
    const nested = payload[key];

    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return this.asNullableString((nested as Record<string, unknown>).status);
    }

    return null;
  }
}
