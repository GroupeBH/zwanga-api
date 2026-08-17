import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFiles,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import {
  RegisterDto,
  LoginDto,
  RefreshTokenDto,
  AuthResponseDto,
  GoogleMobileAuthDto,
  AppleMobileAuthDto,
} from './dto/auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { UserGender, UserRole } from '../users/entities/user.entity';
import { VehicleType } from '../vehicles/entities/vehicle.entity';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

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

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Public()
  @SensitiveThrottle(5, 60000) // 5 requests per minute per IP
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'profilePicture', maxCount: 1 },
        { name: 'cniImage', maxCount: 1 },
        { name: 'selfieImage', maxCount: 1 },
      ],
      {
        limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
      },
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Register a new user with optional files' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', example: '+243900000000' },
        pin: {
          type: 'string',
          example: '1234',
          description: 'PIN à 4 chiffres',
        },
        firstName: { type: 'string', example: 'John' },
        lastName: { type: 'string', example: 'Doe' },
        gender: {
          type: 'string',
          enum: Object.values(UserGender),
          example: UserGender.FEMALE,
          nullable: true,
          description: "Sexe choisi par l'utilisateur (optionnel)",
        },
        role: {
          type: 'string',
          enum: Object.values(UserRole),
          example: UserRole.DRIVER,
          description: 'Rôle de l\’utilisateur (driver, passenger, admin)',
        },
        isDriver: {
          type: 'boolean',
          example: true,
          description: 'Indique si l\’utilisateur souhaite conduire',
        },
        vehicle: {
          type: 'object',
          description:
            'Informations du véhicule (optionnel, conducteurs uniquement)',
          properties: {
            type: {
              type: 'string',
              enum: Object.values(VehicleType),
              default: VehicleType.CAR,
              example: VehicleType.MOTORCYCLE_TWO_WHEELS,
            },
            brand: { type: 'string', example: 'Toyota' },
            model: { type: 'string', example: 'Corolla' },
            color: { type: 'string', example: 'Noir' },
            licensePlate: { type: 'string', example: 'ABC-1234' },
            photoUrl: { type: 'string', example: 'https://...' },
          },
        },
        profilePicture: {
          type: 'string',
          format: 'binary',
          description: 'Photo de profil (optionnel)',
        },
        cniImage: {
          type: 'string',
          format: 'binary',
          description: "Image de la pièce d'identité (optionnel)",
        },
        selfieImage: {
          type: 'string',
          format: 'binary',
          description: 'Photo selfie pour validation (optionnel)',
        },
      },
    },
  })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async register(
    @Body() registerDto: RegisterDto,
    @UploadedFiles()
    files: {
      profilePicture?: Array<MulterFile>;
      cniImage?: Array<MulterFile>;
      selfieImage?: Array<MulterFile>;
    },
  ) {
    const user = await this.authService.register(registerDto, files);
    return user;
  }

  @Post('login')
  @Public()
  @SensitiveThrottle(10, 60000) // 10 requests per minute per IP
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login user with phone number and PIN' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid phone number or PIN' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('refresh')
  @Public()
  @SensitiveThrottle(20, 60000) // 20 requests per minute per IP
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.authService.refreshToken(refreshTokenDto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout user and invalidate refresh token' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(@Req() req: Request) {
    const user = req.user as { userId: string };
    return this.authService.logout(user.userId);
  }

  @Post('google/mobile')
  @Public()
  @SensitiveThrottle(20, 60000)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Google Sign-In (mobile): idToken + phone -> JWT tokens',
  })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid Google token' })
  async googleMobile(@Body() dto: GoogleMobileAuthDto) {
    return this.authService.googleMobileLogin(
      dto.idToken,
      dto.phone,
      dto.gender,
    );
  }

  @Post('apple/mobile')
  @Public()
  @SensitiveThrottle(20, 60000)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apple Sign-In (mobile): identityToken + phone -> JWT tokens',
  })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid Apple token' })
  async appleMobile(@Body() dto: AppleMobileAuthDto) {
    return this.authService.appleMobileLogin(dto);
  }

  @Get('google')
  @Public()
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Initiate Google OAuth authentication' })
  @ApiResponse({ status: 302, description: 'Redirects to Google OAuth' })
  async googleAuth() {
    // Guard redirects to Google
  }

  @Get('google/callback')
  @Public()
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Google OAuth callback' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Authentication failed' })
  async googleAuthCallback(@Req() req: Request, @Res() res: Response) {
    const googleProfile = req.user;
    const authResponse =
      await this.authService.validateGoogleUser(googleProfile);

    // Redirect to frontend with tokens in query params or return JSON
    // You can customize this based on your frontend needs
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(
      `${frontendUrl}/auth/callback?accessToken=${authResponse.accessToken}&refreshToken=${authResponse.refreshToken}`,
    );
  }
}
