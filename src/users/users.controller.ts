import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto, UploadKycDto } from './dto/user.dto';
import { Auth } from '../auth/decorators/auth.decorator';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  @Auth()
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@Request() req) {
    return this.usersService.findOne(req.user.userId);
  }

  @Put('profile')
  @Auth()
  @ApiOperation({ summary: 'Update user profile' })
  async updateProfile(@Request() req, @Body() updateProfileDto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.userId, updateProfileDto);
  }

  @Post('kyc')
  @Auth()
  @ApiOperation({ summary: 'Upload KYC documents' })
  async uploadKyc(@Request() req, @Body() uploadKycDto: UploadKycDto) {
    return this.usersService.uploadKyc(req.user.userId, uploadKycDto);
  }

  @Get('kyc/status')
  @Auth()
  @ApiOperation({ summary: 'Get KYC verification status' })
  async getKycStatus(@Request() req) {
    return this.usersService.getKycStatus(req.user.userId);
  }

  @Post('fcm-token')
  @Auth()
  @ApiOperation({ summary: 'Update FCM token for push notifications' })
  async updateFcmToken(@Request() req, @Body('fcmToken') fcmToken: string) {
    await this.usersService.updateFcmToken(req.user.userId, fcmToken);
    return { message: 'FCM token updated successfully' };
  }
}

