import { Injectable, UnauthorizedException, Logger, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import * as bcrypt from 'bcrypt';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { RegisterDto, LoginDto, RefreshTokenDto, AuthResponseDto } from './dto/auth.dto';
import { FileUploadService } from '../common/services/file-upload.service';
import { VehiclesService } from '../vehicles/vehicles.service';


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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client;

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private fileUploadService: FileUploadService,
    private vehiclesService: VehiclesService,
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
    console.log('registerDto', registerDto);
    console.log('files', files);
    const { phone, pin, firstName, lastName, role, isDriver, vehicle } = registerDto;
    const resolvedIsDriver = isDriver ?? role === UserRole.DRIVER;

    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: [{ phone }],
    });

    if (existingUser) {
      throw new UnauthorizedException('Ce numéro de téléphone existe déjà');
    }

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
      firstName,
      lastName,
      role,
      isDriver: resolvedIsDriver,
      status: UserStatus.PENDING_KYC,
    };

    if (profilePicturePath) {
      userData.profilePicture = profilePicturePath;
    }

    const user = this.userRepository.create(userData);
    const savedUser = await this.userRepository.save(user);

    if (vehicle && !resolvedIsDriver) {
      throw new BadRequestException('Les informations du véhicule sont uniquement autorisées pour les conducteurs');
    }

    if (vehicle && resolvedIsDriver) {
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

  async login(loginDto: LoginDto) {
    // Find user by phone
    const user = await this.userRepository.findOne({ where: { phone: loginDto.phone } });

    if (!user) {
      this.logger.warn(`Login failed: User not found for phone: ${loginDto.phone}`);
      throw new UnauthorizedException('Numéro de téléphone ou code PIN invalide');
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Compte suspendu');
    }

    // Handle PIN validation or reset
    if (loginDto.newPin) {
      // User wants to reset PIN (forgot old PIN)
      this.logger.log(`PIN reset requested during login for user ${user.id}`);
      
      // Hash the new PIN
      const saltRounds = 10;
      const hashedNewPin = await bcrypt.hash(loginDto.newPin, saltRounds);
      
      // Update user password with new hashed PIN
      user.password = hashedNewPin;
      await this.userRepository.save(user);
      
      this.logger.log(`PIN reset successfully during login for user ${user.id}`);
    } else if (loginDto.pin) {
      // Normal login with PIN validation
      const validatedUser = await this.validateUser(loginDto.phone, loginDto.pin);
      
      if (!validatedUser) {
        this.logger.warn(`Login failed: Invalid PIN for phone: ${loginDto.phone}`);
        throw new UnauthorizedException('Numéro de téléphone ou code PIN invalide. Si vous avez oublié votre code PIN, fournissez un newPin pour le réinitialiser.');
      }
    } else {
      // No PIN provided and no newPin provided
      this.logger.warn(`Login failed: No PIN provided for phone: ${loginDto.phone}`);
      throw new UnauthorizedException('Le code PIN est requis. Si vous avez oublié votre code PIN, fournissez un newPin pour le réinitialiser.');
    }

    // Update last login
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    const tokens = await this.generateTokens(user);

    console.log("user status is", user.status);

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
    await this.userRepository.save(user);

    this.logger.log(`User ${userId} logged out successfully`);

    return { message: 'Déconnexion réussie' };
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
      throw new UnauthorizedException('Google OAuth is not configured');
    }

    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience,
      });
      const payload = ticket.getPayload();
      if (!payload || !payload.sub || !payload.email) {
        throw new UnauthorizedException('Invalid Google token payload');
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
      throw new UnauthorizedException('Invalid Google token');
    }
  }

  async googleMobileLogin(idToken: string, phone?: string): Promise<AuthResponseDto> {
    const googleProfile = await this.verifyGoogleIdToken(idToken);
    // Reuse existing linking/creation logic
    return this.validateGoogleUser({
      googleId: googleProfile.googleId,
      email: googleProfile.email,
      firstName: googleProfile.firstName,
      lastName: googleProfile.lastName,
      profilePicture: googleProfile.profilePicture,
    }, phone);
  }

  async validateGoogleUser(googleProfile: any, phone?: string): Promise<AuthResponseDto> {
    const { googleId, email, firstName, lastName, profilePicture } = googleProfile;

    // Check if user exists with this Google ID
    let user = await this.userRepository.findOne({
      where: { googleId },
    });

    // LOGIN Google (déjà inscrit) : on ne requiert pas phone
    if (user) {
      if (user.status === UserStatus.SUSPENDED) {
        throw new UnauthorizedException('Compte suspendu');
      }

      user.lastLoginAt = new Date();
      await this.userRepository.save(user);

      const tokens = await this.generateTokens(user);
      return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    }

    if (!user) {
      // Check if user exists with this email
      user = await this.userRepository.findOne({
        where: { email },
      });

      if (user) {
        // Link Google account to existing user
        user.googleId = googleId;
        user.isEmailVerified = true;

        // If phone provided and user has no phone, set it
        if (phone && !user.phone) {
          const phoneOwner = await this.userRepository.findOne({ where: { phone } });
          if (phoneOwner && phoneOwner.id !== user.id) {
            throw new UnauthorizedException('Ce numéro de téléphone est déjà utilisé');
          }
          user.phone = phone;
        }

        if (!user.profilePicture && profilePicture) {
          user.profilePicture = profilePicture;
        }
        await this.userRepository.save(user);
      } else {
        // Create new user with Google account
        if (!phone) {
          throw new UnauthorizedException('Le numéro de téléphone est requis pour la première inscription Google');
        }

        // Ensure phone is not already used
        const phoneOwner = await this.userRepository.findOne({ where: { phone } });
        if (phoneOwner) {
          throw new UnauthorizedException('Ce numéro de téléphone est déjà utilisé');
        }

        user = this.userRepository.create({
          googleId,
          email,
          phone,
          firstName,
          lastName,
          profilePicture,
          role: UserRole.PASSENGER,
          isDriver: false,
          status: UserStatus.PENDING_KYC,
          isEmailVerified: true,
          isPhoneVerified: false,
        });

        user = await this.userRepository.save(user);
        this.logger.log(`New user created via Google OAuth: ${user.id}`);
      }
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Compte suspendu');
    }

    // Update last login
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    // Generate tokens
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
      expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '90d',
    });

    // Save tokens to user
    user.accessToken = accessToken;
    user.refreshToken = refreshToken;
    await this.userRepository.save(user);

    return { accessToken, refreshToken };
  }
}

