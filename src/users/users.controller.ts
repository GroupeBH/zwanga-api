import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Request,
  Param,
  UploadedFiles,
  UploadedFile,
  UseInterceptors,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiParam, ApiQuery } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto, UploadKycDto, SendPhoneVerificationOtpDto, VerifyPhoneOtpDto, ChangePinDto } from './dto/user.dto';
import { CreateFavoriteLocationDto, UpdateFavoriteLocationDto } from './dto/favorite-location.dto';
import { FavoriteLocationType } from './entities/favorite-location.entity';
import { Auth } from '../auth/decorators/auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@Request() req) {
    return this.usersService.getProfileSummary(req.user.userId);
  }

  @Get(':id/public')
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ 
    summary: 'Get public user information',
    description: 'Récupère les informations publiques d\'un utilisateur (driver ou passager) à afficher aux autres utilisateurs. Inclut les statistiques, la note moyenne, et les véhicules si applicable.'
  })
  @ApiParam({ name: 'id', description: 'ID de l\'utilisateur' })
  async getPublicUserInfo(@Param('id') id: string) {
    return this.usersService.getPublicUserInfo(id);
  }

  @Put('me')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Update user profile' })
  @UseInterceptors(FileInterceptor('profilePicture'))
  @ApiConsumes('multipart/form-data')
  async updateProfile(
    @Request() req,
    @Body() updateProfileDto: UpdateProfileDto,
    @UploadedFile() profilePicture?: Express.Multer.File,
  ) {
    return this.usersService.updateProfile(
      req.user.userId,
      updateProfileDto,
      profilePicture,
    );
  }

  @Post('kyc')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'cniFront', maxCount: 2 }, // Allow 1 or 2 CNI front photos
      { name: 'cniBack', maxCount: 1 },
      { name: 'selfie', maxCount: 1 },
    ]),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        // documentNumber: { type: 'string', required: false },
        cniFront: { 
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: '1 or 2 photos of CNI front (recto)',
        },
        cniBack: { type: 'string', format: 'binary' },
        selfie: { type: 'string', format: 'binary' },
      },
      required: ['cniFront', 'cniBack', 'selfie'],
    },
  })
  @ApiOperation({ summary: 'Upload KYC documents' })
  async uploadKyc(
    @Request() req,
    @Body() uploadKycDto: UploadKycDto,
    @UploadedFiles()
    files: {
      cniFront?: Express.Multer.File[];
      cniBack?: Express.Multer.File[];
      selfie?: Express.Multer.File[];
    },
  ) {
    return this.usersService.uploadKyc(req.user.userId, uploadKycDto, files);
  }

  @Get('kyc/status')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get KYC verification status' })
  async getKycStatus(@Request() req) {
    return this.usersService.getKycStatus(req.user.userId);
  }

  @Post('fcm-token')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Update FCM token for push notifications' })
  async updateFcmToken(@Request() req, @Body('fcmToken') fcmToken: string) {
    await this.usersService.updateFcmToken(req.user.userId, fcmToken);
    return { message: 'FCM token updated successfully' };
  }

  @Post('phone/send-otp')
  @Public()
  @SensitiveThrottle(5, 60000) // 5 requests per minute to prevent abuse
  @ApiOperation({ 
    summary: 'Send OTP for phone verification',
    description: 'Envoie un code OTP par SMS pour vérifier un numéro de téléphone. Le contexte (registration/login/update) détermine le comportement : pour l\'inscription, le numéro ne doit pas exister ; pour la connexion/mise à jour, le numéro doit exister.'
  })
  async sendPhoneVerificationOtp(
    @Body() sendOtpDto: SendPhoneVerificationOtpDto,
  ) {
    return this.usersService.sendPhoneVerificationOtp(sendOtpDto);
  }

  @Post('phone/verify')
  @Public()
  @SensitiveThrottle(10, 60000) // 10 requests per minute
  @ApiOperation({ 
    summary: 'Verify phone number with OTP',
    description: 'Vérifie le code OTP reçu par SMS et marque le numéro de téléphone comme vérifié. Si l\'utilisateur existe en base, son numéro sera marqué comme vérifié.'
  })
  async verifyPhoneOtp(
    @Body() verifyOtpDto: VerifyPhoneOtpDto,
  ) {
    return this.usersService.verifyPhoneOtp(verifyOtpDto);
  }

  // ==================== PIN Management Endpoints ====================

  @Put('pin/change')
  @Auth()
  @SensitiveThrottle(5, 60000) // 5 requests per minute (sensitive operation)
  @ApiOperation({ summary: 'Change user PIN' })
  async changePin(
    @Request() req,
    @Body() changePinDto: ChangePinDto,
  ) {
    await this.usersService.changePin(req.user.userId, changePinDto);
    return { message: 'PIN changed successfully' };
  }

  // ==================== Favorite Locations Endpoints ====================

  @Post('favorite-locations')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Create a favorite location (home, work, etc.)' })
  async createFavoriteLocation(
    @Request() req,
    @Body() createDto: CreateFavoriteLocationDto,
  ) {
    return this.usersService.createFavoriteLocation(req.user.userId, createDto);
  }

  @Get('favorite-locations')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get all favorite locations for the current user' })
  async findAllFavoriteLocations(@Request() req) {
    return this.usersService.findAllFavoriteLocations(req.user.userId);
  }

  @Get('favorite-locations/default')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get default favorite location (optionally filtered by type)' })
  @ApiQuery({ name: 'type', enum: FavoriteLocationType, required: false })
  async getDefaultFavoriteLocation(
    @Request() req,
    @Query('type') type?: FavoriteLocationType,
  ) {
    return this.usersService.getDefaultFavoriteLocation(req.user.userId, type);
  }

  @Get('favorite-locations/:id')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get a favorite location by ID' })
  @ApiParam({ name: 'id', description: 'Favorite location ID' })
  async findFavoriteLocationById(
    @Request() req,
    @Param('id') id: string,
  ) {
    return this.usersService.findFavoriteLocationById(req.user.userId, id);
  }

  @Put('favorite-locations/:id')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Update a favorite location' })
  @ApiParam({ name: 'id', description: 'Favorite location ID' })
  async updateFavoriteLocation(
    @Request() req,
    @Param('id') id: string,
    @Body() updateDto: UpdateFavoriteLocationDto,
  ) {
    return this.usersService.updateFavoriteLocation(req.user.userId, id, updateDto);
  }

  @Delete('favorite-locations/:id')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Delete a favorite location' })
  @ApiParam({ name: 'id', description: 'Favorite location ID' })
  async deleteFavoriteLocation(
    @Request() req,
    @Param('id') id: string,
  ) {
    await this.usersService.deleteFavoriteLocation(req.user.userId, id);
    return { message: 'Favorite location deleted successfully' };
  }
}

