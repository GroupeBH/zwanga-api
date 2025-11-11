import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  Query,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Auth } from '../auth/decorators/auth.decorator';

@ApiTags('Admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('kyc/pending')
  @Auth()
  @ApiOperation({ summary: 'Get all pending KYC verifications' })
  async getPendingKycs(@Request() req) {
    return this.adminService.getPendingKycs();
  }

  @Put('kyc/:kycId/verify')
  @Auth()
  @ApiOperation({ summary: 'Verify or reject KYC document' })
  async verifyKyc(
    @Request() req,
    @Param('kycId') kycId: string,
    @Body('approved') approved: boolean,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.verifyKyc(kycId, req.user.userId, approved, reason);
  }

  @Get('users')
  @Auth()
  @ApiOperation({ summary: 'Get all users (paginated)' })
  async getAllUsers(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ) {
    return this.adminService.getAllUsers(page, limit);
  }

  @Put('users/:userId/suspend')
  @Auth()
  @ApiOperation({ summary: 'Suspend a user' })
  async suspendUser(@Request() req, @Param('userId') userId: string) {
    return this.adminService.suspendUser(userId, req.user.userId);
  }

  @Put('users/:userId/activate')
  @Auth()
  @ApiOperation({ summary: 'Activate a user' })
  async activateUser(@Request() req, @Param('userId') userId: string) {
    return this.adminService.activateUser(userId, req.user.userId);
  }

  @Get('trips')
  @Auth()
  @ApiOperation({ summary: 'Get all trips (paginated)' })
  async getAllTrips(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ) {
    return this.adminService.getAllTrips(page, limit);
  }
}

