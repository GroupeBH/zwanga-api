import {
  Injectable,
  UnauthorizedException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey,
} from 'crypto';
import * as bcrypt from 'bcrypt';
import {
  User,
  UserGender,
  UserRole,
  UserStatus,
} from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import {
  RegisterDto,
  LoginDto,
  RefreshTokenDto,
  AuthResponseDto,
  AppleMobileAuthDto,
  AdminBootstrapConfirmDto,
  AdminBootstrapSendOtpDto,
  AdminChangePasswordDto,
  AdminLoginDto,
  GoogleMobileAuthDto,
  PinResetConfirmDto,
  PinResetRequestDto,
  PinResetVerifyOtpDto,
} from './dto/auth.dto';
import { FileUploadService } from '../common/services/file-upload.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ReferralsService } from '../referrals/referrals.service';
import {
  assertSelfServiceUserRole,
  isAdminRole,
  resolveSelfServiceDriverState,
} from '../users/user-role.policy';
import { KeccelOtpService } from '../keccel-otp/keccel-otp.service';
import { OTP_SMS_MESSAGES } from '../keccel-otp/otp-messages';
import { provisionAdminAccount } from '../admin/admin-account.provisioning';
import { normalizeLegalName } from '../users/legal-identity.util';
import { RedisService } from '../common/services/redis.service';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_PUBLIC_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_KEYS_CACHE_MS = 6 * 60 * 60 * 1000;
const TOKEN_CLOCK_TOLERANCE_SECONDS = 300;
const PIN_RESET_TOKEN_TTL_SECONDS = 5 * 60;
const PIN_RESET_KEY_PREFIX = 'auth:pin-reset:';
const PIN_RESET_OTP_KEY_PREFIX = 'auth:pin-reset-otp:';
const PIN_RESET_OTP_PENDING_VALUE = 'pending';
const PIN_RESET_GENERIC_MESSAGE =
  'Si ce compte peut être réinitialisé, un code OTP a été envoyé.';

interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
  destination?: string;
  filename?: string;
  path?: string;
}

interface AppleJwk extends JsonWebKey {
  kid: string;
  kty: string;
  use?: string;
  alg?: string;
}

interface AppleJwksResponse {
  keys: AppleJwk[];
}

interface AppleJwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface AppleIdTokenPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  nonce?: string;
}

interface AppleAuthProfile {
  appleId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  emailVerified: boolean;
}

export interface GoogleAuthProfile {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  profilePicture: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client;
  private applePublicKeys: AppleJwk[] = [];
  private applePublicKeysExpiresAt = 0;

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private fileUploadService: FileUploadService,
    private vehiclesService: VehiclesService,
    private referralsService: ReferralsService,
    private keccelOtpService: KeccelOtpService,
    private redisService: RedisService,
  ) {
    this.googleClient = new OAuth2Client();
  }

  async register(
    registerDto: RegisterDto,
    files?: {
      profilePicture?: Array<MulterFile>;
      cniImage?: Array<MulterFile>;
      selfieImage?: Array<MulterFile>;
    },
  ): Promise<AuthResponseDto> {
    const {
      phone,
      pin,
      firstName,
      lastName,
      gender,
      role,
      isDriver,
      vehicle,
      referralCode,
      referralToken,
      referralProvider,
      referralReferringLink,
      referralCapturedAt,
    } = registerDto;
    assertSelfServiceUserRole(role);
    const legalFirstName = normalizeLegalName(firstName);
    const legalLastName = normalizeLegalName(lastName);

    const referralAttribution = {
      referralCode,
      referralToken,
      referralProvider,
      referralReferringLink,
      referralCapturedAt,
    };
    const driverState = resolveSelfServiceDriverState({
      role,
      isDriver,
      hasVehicle: Boolean(vehicle),
    });

    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: [{ phone }],
    });

    if (existingUser) {
      throw new UnauthorizedException('Ce numéro de téléphone existe déjà');
    }

    await this.referralsService.assertReferralAttribution(referralAttribution);

    // Hash the PIN
    const saltRounds = 10;
    const hashedPin = await bcrypt.hash(pin, saltRounds);

    // Handle file uploads
    let profilePicturePath: string | null = null;
    let cniImagePath: string | null = null;
    let selfieImagePath: string | null = null;

    if (files) {
      // Save profile picture
      if (files.profilePicture && files.profilePicture.length > 0) {
        profilePicturePath = await this.fileUploadService.saveFile(
          files.profilePicture[0],
          'profiles',
        );
      }

      // Save CNI image
      if (files.cniImage && files.cniImage.length > 0) {
        cniImagePath = await this.fileUploadService.saveFile(
          files.cniImage[0],
          'kyc',
        );
      }

      // Save selfie image
      if (files.selfieImage && files.selfieImage.length > 0) {
        selfieImagePath = await this.fileUploadService.saveFile(
          files.selfieImage[0],
          'kyc',
        );
      }
    }

    // Create user
    const userData: Partial<User> = {
      phone,
      password: hashedPin, // Store hashed PIN
      firstName: legalFirstName,
      lastName: legalLastName,
      gender: gender ?? null,
      role: driverState.role,
      isDriver: driverState.isDriver,
      driverOnboardingRequestedAt: role === UserRole.DRIVER ? new Date() : null,
      status: UserStatus.PENDING_KYC,
    };

    if (profilePicturePath) {
      userData.profilePicture = profilePicturePath;
    }

    const user = this.userRepository.create(userData);
    const savedUser = await this.userRepository.save(user);
    await this.referralsService.registerUser(savedUser.id, referralAttribution);

    if (vehicle && role !== UserRole.DRIVER) {
      throw new BadRequestException(
        'Les informations du véhicule sont uniquement autorisées pour les conducteurs',
      );
    }

    if (vehicle && role === UserRole.DRIVER) {
      await this.vehiclesService.create(savedUser.id, vehicle);
    }

    // Create KYC document if CNI or selfie images are provided
    if (cniImagePath || selfieImagePath) {
      const kycData: Partial<KycDocument> = {
        userId: savedUser.id,
        status: KycStatus.PENDING,
      };

      if (cniImagePath) {
        kycData.cniFrontUrl = cniImagePath;
      }

      if (selfieImagePath) {
        kycData.selfieUrl = selfieImagePath;
      }

      const kycDocument = this.kycDocumentRepository.create(kycData);
      await this.kycDocumentRepository.save(kycDocument);
    }

    // Generate tokens for the newly registered user
    const tokens = await this.generateTokens(savedUser);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      // user: {
      //   id: savedUser.id,
      //   email: savedUser.email || savedUser.phone,
      //   firstName: savedUser.firstName,
      //   lastName: savedUser.lastName,
      //   role: savedUser.role,
      // },
    };
  }

  async validateUser(phone: string, pin: string): Promise<User | null> {
    const user = await this.userRepository.findOne({ where: { phone } });

    if (!user) {
      return null;
    }

    // Check if user has a password (PIN) set
    if (!user.password) {
      this.logger.warn(`User ${phone} does not have a PIN set`);
      return null;
    }

    // Validate PIN
    const isPinValid = await bcrypt.compare(pin, user.password);

    if (!isPinValid) {
      this.logger.warn(`Invalid PIN for user ${phone}`);
      return null;
    }

    return user;
  }

  private assertUserCanAuthenticate(user: User): void {
    if (user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Compte suspendu');
    }

    if (user.status === UserStatus.INACTIVE || !user.isActive) {
      throw new UnauthorizedException('Compte désactivé');
    }
  }

  async login(loginDto: LoginDto) {
    // Find user by phone
    const user = await this.userRepository.findOne({
      where: { phone: loginDto.phone },
    });

    if (!user) {
      this.logger.warn(
        `Login failed: User not found for phone: ${loginDto.phone}`,
      );
      throw new UnauthorizedException(
        'Numéro de téléphone ou code PIN invalide',
      );
    }

    this.assertUserCanAuthenticate(user);

    const validatedUser = await this.validateUser(loginDto.phone, loginDto.pin);

    if (!validatedUser) {
      this.logger.warn(`Login failed: Invalid PIN for user ${user.id}`);
      throw new UnauthorizedException(
        'Numéro de téléphone ou code PIN invalide',
      );
    }

    // Update last login
    user.lastLoginAt = new Date();
    await this.userRepository.update(user.id, { lastLoginAt: user.lastLoginAt });

    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      // user: {
      //   id: user.id,
      //   email: user.email || user.phone,
      //   firstName: user.firstName,
      //   lastName: user.lastName,
      //   role: user.role,
      // },
    };
  }

  async requestPinResetOtp(
    dto: PinResetRequestDto,
  ): Promise<{ message: string }> {
    const user = await this.userRepository.findOne({
      where: { phone: dto.phone },
    });

    // Return the same response for unknown or ineligible accounts to avoid
    // exposing which phone numbers are registered.
    if (!this.canUseSelfServicePinReset(user)) {
      return { message: PIN_RESET_GENERIC_MESSAGE };
    }

    await this.keccelOtpService.sendOtp(
      dto.phone,
      OTP_SMS_MESSAGES.pinReset,
      6,
      PIN_RESET_TOKEN_TTL_SECONDS,
    );
    await this.redisService.set(
      this.getPinResetOtpKey(user.id),
      PIN_RESET_OTP_PENDING_VALUE,
      PIN_RESET_TOKEN_TTL_SECONDS,
    );

    return { message: PIN_RESET_GENERIC_MESSAGE };
  }

  async verifyPinResetOtp(dto: PinResetVerifyOtpDto): Promise<{
    resetToken: string;
    expiresInSeconds: number;
  }> {
    const user = await this.userRepository.findOne({
      where: { phone: dto.phone },
    });

    if (!this.canUseSelfServicePinReset(user)) {
      throw new BadRequestException('Code OTP invalide ou expiré');
    }

    const pendingOtp = await this.redisService.get<string>(
      this.getPinResetOtpKey(user.id),
    );
    if (pendingOtp !== PIN_RESET_OTP_PENDING_VALUE) {
      throw new BadRequestException('Code OTP invalide ou expiré');
    }

    const verification = await this.keccelOtpService.verifyOtp(
      dto.phone,
      dto.otp,
    );

    if (!verification.valid) {
      throw new BadRequestException('Code OTP invalide ou expiré');
    }

    const otpConsumed = await this.redisService.consumeIfValueMatches(
      this.getPinResetOtpKey(user.id),
      PIN_RESET_OTP_PENDING_VALUE,
    );
    if (!otpConsumed) {
      throw new BadRequestException('Code OTP invalide ou expiré');
    }

    const resetToken = `${user.id}.${randomBytes(32).toString('base64url')}`;
    await this.redisService.set(
      this.getPinResetKey(user.id),
      this.hashPinResetToken(resetToken),
      PIN_RESET_TOKEN_TTL_SECONDS,
    );

    this.logger.log(`PIN reset OTP verified for user ${user.id}`);

    return {
      resetToken,
      expiresInSeconds: PIN_RESET_TOKEN_TTL_SECONDS,
    };
  }

  async resetPin(dto: PinResetConfirmDto): Promise<{ message: string }> {
    const userId = this.getUserIdFromPinResetToken(dto.resetToken);
    if (!userId) {
      throw new BadRequestException(
        'Jeton de réinitialisation invalide ou expiré',
      );
    }

    const consumed = await this.redisService.consumeIfValueMatches(
      this.getPinResetKey(userId),
      this.hashPinResetToken(dto.resetToken),
    );

    if (!consumed) {
      throw new BadRequestException(
        'Jeton de réinitialisation invalide ou expiré',
      );
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!this.canUseSelfServicePinReset(user)) {
      throw new BadRequestException(
        'Jeton de réinitialisation invalide ou expiré',
      );
    }

    user.password = await bcrypt.hash(dto.newPin, 10);
    user.refreshToken = null;
    user.accessToken = null;
    await this.userRepository.update(user.id, { password: user.password, refreshToken: null, accessToken: null });

    this.logger.log(`PIN reset completed for user ${user.id}`);

    return {
      message:
        'Code PIN réinitialisé. Les jetons de rafraîchissement ont été invalidés.',
    };
  }

  private canUseSelfServicePinReset(user: User | null): user is User {
    return Boolean(
      user &&
      !isAdminRole(user.role) &&
      user.isActive &&
      user.status !== UserStatus.SUSPENDED &&
      user.status !== UserStatus.INACTIVE,
    );
  }

  private getPinResetKey(userId: string): string {
    return `${PIN_RESET_KEY_PREFIX}${userId}`;
  }

  private getPinResetOtpKey(userId: string): string {
    return `${PIN_RESET_OTP_KEY_PREFIX}${userId}`;
  }

  private hashPinResetToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private getUserIdFromPinResetToken(token: string): string | null {
    const parts = token.split('.');
    if (
      parts.length !== 2 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parts[0],
      ) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
    ) {
      return null;
    }

    return parts[0];
  }

  async adminLogin(loginDto: AdminLoginDto): Promise<AuthResponseDto> {
    const user = await this.userRepository.findOne({
      where: { phone: loginDto.phone },
    });

    if (!user) {
      this.logger.warn(
        `Admin login failed: User not found for phone: ${loginDto.phone}`,
      );
      throw new UnauthorizedException(
        'Numéro de téléphone ou mot de passe invalide',
      );
    }

    this.assertUserCanAuthenticate(user);

    if (!isAdminRole(user.role)) {
      this.logger.warn(`Admin login rejected for non-admin user ${user.id}`);
      throw new UnauthorizedException(
        "Ce compte n'a pas accès à l'interface admin",
      );
    }

    const password = loginDto.password ?? loginDto.pin;
    if (!password) {
      throw new UnauthorizedException('Le mot de passe admin est requis');
    }

    const validatedUser = await this.validateUser(loginDto.phone, password);
    if (!validatedUser) {
      this.logger.warn(
        `Admin login failed: Invalid password for phone: ${loginDto.phone}`,
      );
      throw new UnauthorizedException(
        'Numéro de téléphone ou mot de passe invalide',
      );
    }

    user.lastLoginAt = new Date();
    await this.userRepository.update(user.id, { lastLoginAt: user.lastLoginAt });

    const tokens = await this.generateTokens(user);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      passwordChangeRequired: user.passwordChangeRequired,
    };
  }

  async changeAdminPassword(
    userId: string,
    dto: AdminChangePasswordDto,
  ): Promise<{ message: string; passwordChangeRequired: boolean }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Utilisateur non trouvé');
    }

    this.assertUserCanAuthenticate(user);

    if (!isAdminRole(user.role)) {
      throw new UnauthorizedException(
        "Ce compte n'a pas accès à l'interface admin",
      );
    }

    if (!user.password) {
      throw new BadRequestException(
        'Aucun mot de passe administrateur défini pour ce compte',
      );
    }

    const currentPasswordIsValid = await bcrypt.compare(
      dto.currentPassword,
      user.password,
    );
    if (!currentPasswordIsValid) {
      throw new UnauthorizedException('Mot de passe actuel invalide');
    }

    const samePassword = await bcrypt.compare(dto.newPassword, user.password);
    if (samePassword) {
      throw new BadRequestException(
        "Le nouveau mot de passe doit être différent de l'ancien",
      );
    }

    user.password = await bcrypt.hash(dto.newPassword, 12);
    user.passwordChangeRequired = false;
    await this.userRepository.update(user.id, { password: user.password, passwordChangeRequired: false });

    return {
      message: 'Mot de passe administrateur modifié avec succès',
      passwordChangeRequired: false,
    };
  }

  async sendAdminBootstrapOtp(
    dto: AdminBootstrapSendOtpDto,
    bootstrapSecret?: string,
  ): Promise<{ message: string }> {
    this.assertAdminBootstrapSecret(bootstrapSecret);
    await this.assertAdminBootstrapIsAvailable();
    this.assertAdminBootstrapPhone(dto.phone);

    await this.keccelOtpService.sendOtp(
      this.getConfiguredAdminBootstrapPhone(),
      OTP_SMS_MESSAGES.adminBootstrap,
      6,
      300,
    );

    return {
      message: 'Code OTP de bootstrap envoyé au numéro super administrateur',
    };
  }

  async confirmAdminBootstrap(
    dto: AdminBootstrapConfirmDto,
    bootstrapSecret?: string,
  ): Promise<{
    message: string;
    admin: {
      id: string;
      phone: string;
      firstName: string;
      lastName: string;
      role: UserRole;
      passwordChangeRequired: boolean;
      isPhoneVerified: boolean;
    };
  }> {
    this.assertAdminBootstrapSecret(bootstrapSecret);
    await this.assertAdminBootstrapIsAvailable();
    this.assertAdminBootstrapPhone(dto.phone);

    const phone = this.getConfiguredAdminBootstrapPhone();
    const verificationResult = await this.keccelOtpService.verifyOtp(
      phone,
      dto.otp,
    );

    if (!verificationResult.valid) {
      throw new BadRequestException('Code OTP invalide ou expiré');
    }

    const configuredPassword = this.configService.get<string>(
      'ADMIN_BOOTSTRAP_DEFAULT_PASSWORD',
    );
    const password = dto.password ?? configuredPassword;
    if (!password || password.length < 8 || password.length > 128) {
      throw new BadRequestException(
        'Mot de passe de bootstrap absent ou invalide',
      );
    }

    const admin = await this.userRepository.manager.transaction(
      async (manager) => {
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtext('zwanga_admin_bootstrap'))`,
        );

        const existingSuperAdmins = await manager.getRepository(User).count({
          where: { role: UserRole.SUPER_ADMIN },
        });
        if (existingSuperAdmins > 0) {
          throw new BadRequestException(
            'Le super administrateur initial existe déjà',
          );
        }

        return provisionAdminAccount(manager.getRepository(User), {
          phone,
          firstName:
            dto.firstName ||
            this.configService.get<string>('ADMIN_BOOTSTRAP_FIRST_NAME') ||
            'Buania',
          lastName:
            dto.lastName ||
            this.configService.get<string>('ADMIN_BOOTSTRAP_LAST_NAME') ||
            'Superadmin',
          password,
          role: UserRole.SUPER_ADMIN,
          isPhoneVerified: true,
          passwordChangeRequired: true,
          existingAccountStrategy: 'promote_self_service',
          lockExistingAccount: true,
        });
      },
    );

    return {
      message: 'Super administrateur initial créé avec succès',
      admin: {
        id: admin.id,
        phone: admin.phone,
        firstName: admin.firstName,
        lastName: admin.lastName,
        role: admin.role,
        passwordChangeRequired: admin.passwordChangeRequired,
        isPhoneVerified: admin.isPhoneVerified,
      },
    };
  }

  async refreshToken(refreshTokenDto: RefreshTokenDto) {
    try {
      const payload = await this.jwtService.verifyAsync(
        refreshTokenDto.refreshToken,
        {
          secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        },
      );

      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
      });

      if (!user || user.refreshToken !== refreshTokenDto.refreshToken) {
        throw new UnauthorizedException('Token de rafraîchissement invalide');
      }

      const tokens = await this.generateTokens(user);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    } catch (error) {
      throw new UnauthorizedException('Token de rafraîchissement invalide');
    }
  }

  /**
   * Logout user by invalidating the refresh token
   * This ensures the refresh token cannot be reused
   */
  async logout(userId: string): Promise<{ message: string }> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('Utilisateur non trouvé');
    }

    // Invalidate the refresh token by setting it to null
    user.refreshToken = null;
    user.accessToken = null;
    await this.userRepository.update(user.id, { refreshToken: null, accessToken: null });

    this.logger.log(`User ${userId} logged out successfully`);

    return { message: 'Déconnexion réussie' };
  }

  private async assertAdminBootstrapIsAvailable(): Promise<void> {
    const existingSuperAdmins = await this.userRepository.count({
      where: { role: UserRole.SUPER_ADMIN },
    });

    if (existingSuperAdmins > 0) {
      throw new BadRequestException(
        'Le super administrateur initial existe déjà',
      );
    }
  }

  private assertAdminBootstrapSecret(receivedSecret?: string): void {
    const configuredSecret = this.configService
      .get<string>('ADMIN_BOOTSTRAP_SECRET')
      ?.trim();

    if (!configuredSecret) {
      throw new UnauthorizedException(
        "Le bootstrap super administrateur n'est pas configuré",
      );
    }

    if (!this.safeEquals(configuredSecret, receivedSecret?.trim() ?? '')) {
      throw new UnauthorizedException('Clé de bootstrap invalide');
    }
  }

  private safeEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  private assertAdminBootstrapPhone(phone: string): void {
    if (
      this.normalizePhoneForIdentity(phone) !==
      this.getConfiguredAdminBootstrapPhone()
    ) {
      throw new UnauthorizedException(
        'Numéro non autorisé pour le bootstrap super administrateur',
      );
    }
  }

  private getConfiguredAdminBootstrapPhone(): string {
    const configuredPhone = this.configService
      .get<string>('ADMIN_BOOTSTRAP_PHONE')
      ?.trim();

    if (!configuredPhone) {
      throw new UnauthorizedException(
        "Le numéro de bootstrap super administrateur n'est pas configuré",
      );
    }

    return this.normalizePhoneForIdentity(configuredPhone);
  }

  private normalizePhoneForIdentity(phone: string): string {
    const defaultCountryCode = (
      this.configService.get<string>('DEFAULT_COUNTRY_CODE') || '+243'
    ).replace(/\D/g, '');
    let normalized = phone.trim().replace(/[\s().-]/g, '');

    if (normalized.startsWith('00')) {
      normalized = `+${normalized.slice(2)}`;
    }

    if (normalized.startsWith('0')) {
      normalized = `+${defaultCountryCode}${normalized.slice(1)}`;
    }

    if (!normalized.startsWith('+')) {
      normalized = `+${normalized}`;
    }

    return normalized;
  }

  private getGoogleAudiences(): string[] {
    const raw =
      this.configService.get<string>('GOOGLE_MOBILE_CLIENT_IDS') ||
      this.configService.get<string>('GOOGLE_CLIENT_ID') ||
      '';

    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private async verifyGoogleIdToken(idToken: string) {
    const audience = this.getGoogleAudiences();
    if (audience.length === 0) {
      this.logger.error('Missing GOOGLE_MOBILE_CLIENT_IDS / GOOGLE_CLIENT_ID');
      throw new UnauthorizedException("La connexion avec Google est temporairement indisponible.");
    }

    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience,
      });
      const payload = ticket.getPayload();
      if (!payload || !payload.sub || !payload.email) {
        throw new UnauthorizedException("La réponse de connexion Google est invalide. Relancez la connexion.");
      }

      return {
        googleId: payload.sub,
        email: payload.email,
        firstName: payload.given_name ?? '',
        lastName: payload.family_name ?? '',
        profilePicture: payload.picture ?? null,
        emailVerified: payload.email_verified ?? false,
      };
    } catch (e) {
      throw new UnauthorizedException("La connexion avec Google n’a pas pu être vérifiée. Réessayez.");
    }
  }

  async googleMobileLogin(
    idToken: string,
    phone?: string,
    gender?: UserGender | null,
    signupOptions?: Pick<
      GoogleMobileAuthDto,
      | 'role'
      | 'isDriver'
      | 'vehicle'
      | 'firstName'
      | 'lastName'
      | 'referralCode'
      | 'referralToken'
      | 'referralProvider'
      | 'referralReferringLink'
      | 'referralCapturedAt'
    >,
  ): Promise<AuthResponseDto> {
    const googleProfile = await this.verifyGoogleIdToken(idToken);
    // Reuse existing linking/creation logic
    return this.validateGoogleUser(
      {
        googleId: googleProfile.googleId,
        email: googleProfile.email,
        firstName: googleProfile.firstName,
        lastName: googleProfile.lastName,
        profilePicture: googleProfile.profilePicture,
      },
      phone,
      gender,
      signupOptions,
    );
  }

  async validateGoogleUser(
    googleProfile: GoogleAuthProfile,
    phone?: string,
    gender?: UserGender | null,
    signupOptions?: Pick<
      GoogleMobileAuthDto,
      | 'role'
      | 'isDriver'
      | 'vehicle'
      | 'firstName'
      | 'lastName'
      | 'referralCode'
      | 'referralToken'
      | 'referralProvider'
      | 'referralReferringLink'
      | 'referralCapturedAt'
    >,
  ): Promise<AuthResponseDto> {
    const { googleId, email, firstName, lastName, profilePicture } =
      googleProfile;

    // Check if user exists with this Google ID
    let user = await this.userRepository.findOne({
      where: { googleId },
    });

    // LOGIN Google (déjà inscrit) : on ne requiert pas phone
    if (user) {
      this.assertUserCanAuthenticate(user);

      user.lastLoginAt = new Date();
      await this.userRepository.update(user.id, { lastLoginAt: user.lastLoginAt });

      const tokens = await this.generateTokens(user);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    }

    if (!user) {
      // Check if user exists with this email
      user = await this.userRepository.findOne({
        where: { email },
      });

      if (user) {
        this.assertUserCanAuthenticate(user);

        // Link Google account to existing user
        user.googleId = googleId;
        user.isEmailVerified = true;

        // If phone provided and user has no phone, set it
        if (phone && !user.phone) {
          const phoneOwner = await this.userRepository.findOne({
            where: { phone },
          });
          if (phoneOwner && phoneOwner.id !== user.id) {
            throw new UnauthorizedException(
              'Ce numéro de téléphone est déjà utilisé',
            );
          }
          user.phone = phone;
        }

        if (!user.profilePicture && profilePicture) {
          user.profilePicture = profilePicture;
        }
        await this.userRepository.update(user.id, {
          googleId: user.googleId, isEmailVerified: user.isEmailVerified,
          phone: user.phone, profilePicture: user.profilePicture,
        });
      } else {
        // Create new user with Google account
        if (!phone) {
          throw new UnauthorizedException(
            'Le numéro de téléphone est requis pour la première inscription Google',
          );
        }

        // Ensure phone is not already used
        const phoneOwner = await this.userRepository.findOne({
          where: { phone },
        });
        if (phoneOwner) {
          throw new UnauthorizedException(
            'Ce numéro de téléphone est déjà utilisé',
          );
        }

        const role = signupOptions?.role ?? UserRole.PASSENGER;
        assertSelfServiceUserRole(role);

        const vehicle = signupOptions?.vehicle;
        const driverState = resolveSelfServiceDriverState({
          role,
          isDriver: signupOptions?.isDriver,
          hasVehicle: Boolean(vehicle),
        });
        const legalFirstName = normalizeLegalName(
          signupOptions?.firstName || firstName,
        );
        const legalLastName = normalizeLegalName(
          signupOptions?.lastName || lastName,
        );

        if (role === UserRole.DRIVER && (!legalFirstName || !legalLastName)) {
          throw new BadRequestException(
            'Vos prénom(s) et votre nom exacts sont requis avant la vérification KYC. Le post-nom est facultatif.',
          );
        }
        const referralAttribution = {
          referralCode: signupOptions?.referralCode,
          referralToken: signupOptions?.referralToken,
          referralProvider: signupOptions?.referralProvider,
          referralReferringLink: signupOptions?.referralReferringLink,
          referralCapturedAt: signupOptions?.referralCapturedAt,
        };

        await this.referralsService.assertReferralAttribution(
          referralAttribution,
        );

        if (vehicle && role !== UserRole.DRIVER) {
          throw new BadRequestException(
            'Les informations du véhicule sont uniquement autorisées pour les conducteurs',
          );
        }

        user = this.userRepository.create({
          googleId,
          email,
          phone,
          firstName: legalFirstName,
          lastName: legalLastName,
          gender: gender ?? null,
          profilePicture: profilePicture ?? undefined,
          role: driverState.role,
          isDriver: driverState.isDriver,
          driverOnboardingRequestedAt: role === UserRole.DRIVER ? new Date() : null,
          status: UserStatus.PENDING_KYC,
          isEmailVerified: true,
          isPhoneVerified: false,
        });

        user = await this.userRepository.save(user);
        await this.referralsService.registerUser(user.id, referralAttribution);
        if (vehicle && role === UserRole.DRIVER) {
          await this.vehiclesService.create(user.id, vehicle);
        }
        this.logger.log(`New user created via Google OAuth: ${user.id}`);
      }
    }

    this.assertUserCanAuthenticate(user);

    // Update last login
    user.lastLoginAt = new Date();
    await this.userRepository.update(user.id, { lastLoginAt: user.lastLoginAt });

    // Generate tokens
    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  private getAppleAudiences(): string[] {
    const raw =
      this.configService.get<string>('APPLE_CLIENT_IDS') ||
      this.configService.get<string>('APPLE_CLIENT_ID') ||
      '';

    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private decodeJwtPart<T>(value: string, message: string): T {
    try {
      return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
    } catch {
      throw new UnauthorizedException(message);
    }
  }

  private async getApplePublicKeys(forceRefresh = false): Promise<AppleJwk[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.applePublicKeys.length > 0 &&
      this.applePublicKeysExpiresAt > now
    ) {
      return this.applePublicKeys;
    }

    try {
      const response = await fetch(APPLE_PUBLIC_KEYS_URL);
      if (!response.ok) {
        throw new Error(
          `Apple keys request failed with status ${response.status}`,
        );
      }

      const jwks = (await response.json()) as AppleJwksResponse;
      if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
        throw new Error('Apple keys response did not include keys');
      }

      this.applePublicKeys = jwks.keys;
      this.applePublicKeysExpiresAt = now + APPLE_KEYS_CACHE_MS;
      return this.applePublicKeys;
    } catch (error) {
      this.logger.error('Unable to fetch Apple public keys', error);
      throw new UnauthorizedException("La connexion avec Apple est temporairement indisponible. Réessayez plus tard.");
    }
  }

  private isAppleAudienceAllowed(
    audience: string | string[] | undefined,
    allowedAudiences: string[],
  ): boolean {
    if (!audience) {
      return false;
    }

    const tokenAudiences = Array.isArray(audience) ? audience : [audience];
    return tokenAudiences.some((aud) => allowedAudiences.includes(aud));
  }

  private isAppleEmailVerified(value: string | boolean | undefined): boolean {
    return value === true || value === 'true' || value === '1';
  }

  private validateAppleClaims(
    payload: AppleIdTokenPayload,
    allowedAudiences: string[],
    expectedNonce?: string,
  ): void {
    if (!payload.sub) {
      throw new UnauthorizedException("La réponse de connexion Apple est invalide. Relancez la connexion.");
    }

    if (payload.iss !== APPLE_ISSUER) {
      throw new UnauthorizedException("L’origine de la réponse de connexion Apple n’a pas pu être vérifiée. Réessayez.");
    }

    if (!this.isAppleAudienceAllowed(payload.aud, allowedAudiences)) {
      throw new UnauthorizedException("Cette connexion Apple n’est pas destinée à cette application. Relancez la connexion.");
    }

    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp + TOKEN_CLOCK_TOLERANCE_SECONDS < now) {
      throw new UnauthorizedException("Votre connexion Apple a expiré. Reconnectez-vous.");
    }

    if (payload.iat && payload.iat - TOKEN_CLOCK_TOLERANCE_SECONDS > now) {
      throw new UnauthorizedException("L’heure de la réponse de connexion Apple est invalide. Relancez la connexion.");
    }

    if (expectedNonce && payload.nonce !== expectedNonce) {
      throw new UnauthorizedException("La réponse Apple ne correspond pas à cette tentative de connexion. Réessayez.");
    }
  }

  private async verifyAppleIdToken(
    idToken: string,
    expectedNonce?: string,
  ): Promise<Pick<AppleAuthProfile, 'appleId' | 'email' | 'emailVerified'>> {
    const allowedAudiences = this.getAppleAudiences();
    if (allowedAudiences.length === 0) {
      this.logger.error('Missing APPLE_CLIENT_IDS / APPLE_CLIENT_ID');
      throw new UnauthorizedException("La connexion avec Apple est temporairement indisponible.");
    }

    const tokenParts = idToken.split('.');
    if (tokenParts.length !== 3) {
      throw new UnauthorizedException("La connexion avec Apple n’a pas pu être vérifiée. Réessayez.");
    }

    const [encodedHeader, encodedPayload, encodedSignature] = tokenParts;
    const header = this.decodeJwtPart<AppleJwtHeader>(
      encodedHeader,
      "La réponse de connexion Apple est invalide. Relancez la connexion.",
    );
    const payload = this.decodeJwtPart<AppleIdTokenPayload>(
      encodedPayload,
      "La réponse de connexion Apple est invalide. Relancez la connexion.",
    );

    if (header.alg !== 'RS256' || !header.kid) {
      throw new UnauthorizedException("La réponse de connexion Apple est invalide. Relancez la connexion.");
    }

    let appleKeys = await this.getApplePublicKeys();
    let appleKey = appleKeys.find((key) => key.kid === header.kid);

    if (!appleKey) {
      appleKeys = await this.getApplePublicKeys(true);
      appleKey = appleKeys.find((key) => key.kid === header.kid);
    }

    if (!appleKey) {
      throw new UnauthorizedException("La connexion avec Apple n’a pas pu être vérifiée. Réessayez.");
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const publicKey = createPublicKey({ key: appleKey, format: 'jwk' });
    const signature = Buffer.from(encodedSignature, 'base64url');
    const isSignatureValid = verifySignature(
      'RSA-SHA256',
      Buffer.from(signingInput),
      publicKey,
      signature,
    );

    if (!isSignatureValid) {
      throw new UnauthorizedException("L’authenticité de la réponse Apple n’a pas pu être vérifiée. Relancez la connexion.");
    }

    this.validateAppleClaims(payload, allowedAudiences, expectedNonce);
    const appleId = payload.sub;
    if (!appleId) {
      throw new UnauthorizedException("La réponse de connexion Apple est invalide. Relancez la connexion.");
    }

    return {
      appleId,
      email: payload.email,
      emailVerified: this.isAppleEmailVerified(payload.email_verified),
    };
  }

  async appleMobileLogin(dto: AppleMobileAuthDto): Promise<AuthResponseDto> {
    const appleProfile = await this.verifyAppleIdToken(dto.idToken, dto.nonce);

    return this.validateAppleUser(
      {
        ...appleProfile,
        firstName: dto.firstName,
        lastName: dto.lastName,
      },
      dto.phone,
      dto,
    );
  }

  async validateAppleUser(
    appleProfile: AppleAuthProfile,
    phone?: string,
    signupOptions?: Pick<
      AppleMobileAuthDto,
      | 'gender'
      | 'role'
      | 'isDriver'
      | 'vehicle'
      | 'referralCode'
      | 'referralToken'
      | 'referralProvider'
      | 'referralReferringLink'
      | 'referralCapturedAt'
    >,
  ): Promise<AuthResponseDto> {
    const { appleId, email, firstName, lastName, emailVerified } = appleProfile;

    let user = await this.userRepository.findOne({
      where: { appleId },
    });

    if (user) {
      this.assertUserCanAuthenticate(user);

      user.lastLoginAt = new Date();
      await this.userRepository.update(user.id, { lastLoginAt: user.lastLoginAt });

      const tokens = await this.generateTokens(user);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    }

    if (email) {
      user = await this.userRepository.findOne({
        where: { email },
      });
    }

    if (user) {
      this.assertUserCanAuthenticate(user);

      user.appleId = appleId;
      user.isEmailVerified = user.isEmailVerified || emailVerified;

      if (phone && !user.phone) {
        const phoneOwner = await this.userRepository.findOne({
          where: { phone },
        });
        if (phoneOwner && phoneOwner.id !== user.id) {
          throw new UnauthorizedException(
            'Ce numéro de téléphone est déjà utilisé',
          );
        }
        user.phone = phone;
      }

      if (firstName && !user.firstName) {
        user.firstName = firstName;
      }

      if (lastName && !user.lastName) {
        user.lastName = lastName;
      }

      await this.userRepository.update(user.id, {
        appleId: user.appleId, isEmailVerified: user.isEmailVerified, phone: user.phone,
        firstName: user.firstName, lastName: user.lastName,
      });
    } else {
      if (!phone) {
        throw new UnauthorizedException(
          'Le numéro de téléphone est requis pour la première inscription Apple',
        );
      }

      const phoneOwner = await this.userRepository.findOne({
        where: { phone },
      });
      if (phoneOwner) {
        throw new UnauthorizedException(
          'Ce numéro de téléphone est déjà utilisé',
        );
      }

      const role = signupOptions?.role ?? UserRole.PASSENGER;
      assertSelfServiceUserRole(role);

      const vehicle = signupOptions?.vehicle;
      const driverState = resolveSelfServiceDriverState({
        role,
        isDriver: signupOptions?.isDriver,
        hasVehicle: Boolean(vehicle),
      });
      const legalFirstName = normalizeLegalName(firstName);
      const legalLastName = normalizeLegalName(lastName);

      if (role === UserRole.DRIVER && (!legalFirstName || !legalLastName)) {
        throw new BadRequestException(
          'Vos prénom(s) et votre nom exacts sont requis avant la vérification KYC. Le post-nom est facultatif.',
        );
      }
      const referralAttribution = {
        referralCode: signupOptions?.referralCode,
        referralToken: signupOptions?.referralToken,
        referralProvider: signupOptions?.referralProvider,
        referralReferringLink: signupOptions?.referralReferringLink,
        referralCapturedAt: signupOptions?.referralCapturedAt,
      };

      await this.referralsService.assertReferralAttribution(
        referralAttribution,
      );

      if (vehicle && role !== UserRole.DRIVER) {
        throw new BadRequestException(
          'Les informations du véhicule sont uniquement autorisées pour les conducteurs',
        );
      }

      user = this.userRepository.create({
        appleId,
        email,
        phone,
        firstName: legalFirstName,
        lastName: legalLastName,
        gender: signupOptions?.gender ?? null,
        role: driverState.role,
        isDriver: driverState.isDriver,
        driverOnboardingRequestedAt: role === UserRole.DRIVER ? new Date() : null,
        status: UserStatus.PENDING_KYC,
        isEmailVerified: emailVerified,
        isPhoneVerified: false,
      });

      user = await this.userRepository.save(user);
      await this.referralsService.registerUser(user.id, referralAttribution);
      if (vehicle && role === UserRole.DRIVER) {
        await this.vehiclesService.create(user.id, vehicle);
      }
      this.logger.log(`New user created via Apple OAuth: ${user.id}`);
    }

    this.assertUserCanAuthenticate(user);

    user.lastLoginAt = new Date();
    await this.userRepository.update(user.id, { lastLoginAt: user.lastLoginAt });

    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  private async generateTokens(user: User) {
    const payload = {
      sub: user.id,
      phone: user.phone,
      role: user.role,
      status: user.status,
    };

    // Access token: 1 day (1d)
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>('JWT_EXPIRES_IN') || '1d',
    });

    // Refresh token: 3 weeks (21d)
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn:
        this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '90d',
    });

    // Save tokens to user
    user.accessToken = accessToken;
    user.refreshToken = refreshToken;
    await this.userRepository.update(user.id, { accessToken, refreshToken });

    return { accessToken, refreshToken };
  }
}
