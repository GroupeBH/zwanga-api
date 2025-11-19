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
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';

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

  @Put('me')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Update user profile' })
  async updateProfile(@Request() req, @Body() updateProfileDto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.userId, updateProfileDto);
  }

  @Post('kyc')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Upload KYC documents' })
  async uploadKyc(@Request() req, @Body() uploadKycDto: UploadKycDto) {
    return this.usersService.uploadKyc(req.user.userId, uploadKycDto);
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
}

