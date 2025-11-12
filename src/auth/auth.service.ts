import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { User, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import { RegisterDto, LoginDto, RefreshTokenDto } from './dto/auth.dto';
import { FileUploadService } from '../common/services/file-upload.service';

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
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private fileUploadService: FileUploadService,
  ) {}

  async register(
    registerDto: RegisterDto,
    files?: {
      profilePicture?: Array<MulterFile>;
      cniImage?: Array<MulterFile>;
      selfieImage?: Array<MulterFile>;
    },
  ): Promise<User> {
    const { phone, firstName, lastName } = registerDto;

    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: [{ phone }],
    });

    if (existingUser) {
      throw new UnauthorizedException('phone already exists');
    }

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
      firstName,
      lastName,
      status: UserStatus.PENDING_KYC,
    };

    if (profilePicturePath) {
      userData.profilePicture = profilePicturePath;
    }

    const user = this.userRepository.create(userData);
    const savedUser = await this.userRepository.save(user);

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

    return savedUser;
  }

  async validateUser(phone: string): Promise<User | null> {
    const user = await this.userRepository.findOne({ where: { phone } });

    if (!user) {
      return null;
    }

    // const isPasswordValid = await bcrypt.compare(password, user.password);

    // if (!isPasswordValid) {
    //   return null;
    // }

    return user;
  }

  async login(loginDto: LoginDto) {
    const user = await this.validateUser(loginDto.phone);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Account is suspended');
    }

    // Update last login
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email || user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
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
        throw new UnauthorizedException('Invalid refresh token');
      }

      const tokens = await this.generateTokens(user);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private async generateTokens(user: User) {
    const payload = {
      sub: user.id,
      email: user.email || user.phone,
      role: user.role,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>('JWT_EXPIRES_IN'),
    });

    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN'),
    });

    // Save refresh token to user
    user.refreshToken = refreshToken;
    await this.userRepository.save(user);

    return { accessToken, refreshToken };
  }
}

