import {
  Controller,
  Delete,
  Get,
  Put,
  Post,
  Body,
  Request,
  Param,
  UploadedFiles,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import {
  UpdateProfileDto,
  UploadKycDto,
  SendPhoneVerificationOtpDto,
  VerifyPhoneOtpDto,
  ChangePinDto,
} from './dto/user.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { Public } from '../common/decorators/public.decorator';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';

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

  @Delete('me')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Deactivate current user account' })
  @ApiResponse({
    status: 200,
    description: 'Account deactivated successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Compte désactivé avec succès' },
      },
    },
  })
  async deactivateAccount(@Request() req) {
    return this.usersService.deactivateAccount(req.user.userId);
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
      { name: 'cniFront', maxCount: 1 },
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
        cniFront: { type: 'string', format: 'binary' },
        cniBack: { type: 'string', format: 'binary' },
        selfie: { type: 'string', format: 'binary' },
      },
      required: ['cniBack', 'selfie'],
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

  @Get(':id/public')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'Get public profile of a user (driver or passenger)',
  })
  async getPublicProfile(@Param('id') id: string) {
    return this.usersService.getPublicUserInfo(id);
  }

  @Post('phone/send-otp')
  @Public()
  @HttpCode(HttpStatus.OK)
  @SensitiveThrottle(5, 60000) // 5 requests per minute per IP
  @ApiOperation({ summary: 'Send OTP code to phone number for verification' })
  @ApiResponse({
    status: 200,
    description: 'OTP sent successfully',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Code de vérification envoyé avec succès',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - Phone already exists or not found',
  })
  async sendPhoneVerificationOtp(
    @Body() sendOtpDto: SendPhoneVerificationOtpDto,
  ) {
    return this.usersService.sendPhoneVerificationOtp(sendOtpDto);
  }

  @Post('phone/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @SensitiveThrottle(10, 60000) // 10 requests per minute per IP
  @ApiOperation({ summary: 'Verify OTP code sent to phone number' })
  @ApiResponse({
    status: 200,
    description: 'OTP verified successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Code OTP vérifié avec succès' },
        valid: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - Invalid or expired OTP',
  })
  async verifyPhoneOtp(@Body() verifyOtpDto: VerifyPhoneOtpDto) {
    return this.usersService.verifyPhoneOtp(verifyOtpDto);
  }

  @Post('pin/change')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @SensitiveThrottle(5, 60000) // 5 requests per minute per IP
  @ApiOperation({ summary: 'Change user PIN code' })
  @ApiResponse({
    status: 200,
    description: 'PIN changed successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Code PIN modifié avec succès' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - Invalid PIN or same PIN',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid old PIN' })
  async changePin(@Request() req, @Body() changePinDto: ChangePinDto) {
    await this.usersService.changePin(req.user.userId, changePinDto);
    return { message: 'Code PIN modifié avec succès' };
  }
}
