import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Request,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto, UploadKycDto } from './dto/user.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { FileFieldsInterceptor } from '@nestjs/platform-express';

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
}

