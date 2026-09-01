import {
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { UpdateTripDto } from '../trips/dto/trip.dto';
import { UpdateTripRequestDto } from '../trip-requests/dto/trip-request.dto';
import { BookingStatus } from '../bookings/entities/booking.entity';
import { AdminWalletAdjustmentDto } from './dto/admin-wallet.dto';
import { AdminReferralsService } from './admin-referrals.service';
import { CreateAdminAccountDto } from './dto/admin-account.dto';

interface AuthenticatedAdminRequest {
  user: { userId: string };
}

@ApiTags('Admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly adminReferralsService: AdminReferralsService,
  ) {}

  @Get('kyc/pending')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000) // 30 requests per minute per IP
  @ApiOperation({ summary: 'Get all pending KYC verifications' })
  async getPendingKycs(@Request() req) {
    return this.adminService.getPendingKycs();
  }

  @Put('kyc/:kycId/verify')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(20, 60000) // 20 requests per minute per IP
  @ApiOperation({ summary: 'Verify or reject KYC document' })
  async verifyKyc(
    @Request() req: AuthenticatedAdminRequest,
    @Param('kycId') kycId: string,
    @Body('approved') approved: boolean,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.verifyKyc(
      kycId,
      req.user.userId,
      approved,
      reason,
    );
  }

  @Get('users')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000) // 30 requests per minute per IP
  @ApiOperation({ summary: 'Get all users (paginated)' })
  async getAllUsers(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ) {
    return this.adminService.getAllUsers(page, limit);
  }

  @Get('accounts')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'List back-office administrator accounts' })
  async getAdminAccounts(
    @Request() req: AuthenticatedAdminRequest,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 25,
  ) {
    return this.adminService.getAdminAccounts(req.user.userId, page, limit);
  }

  @Post('accounts')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Create a back-office administrator account' })
  async createAdminAccount(
    @Request() req: AuthenticatedAdminRequest,
    @Body() dto: CreateAdminAccountDto,
  ) {
    return this.adminService.createAdminAccount(req.user.userId, dto);
  }

  @Get('wallets')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'List token wallets and their global summary' })
  async getWalletAccounts(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 25,
    @Query('search') search?: string,
  ) {
    return this.adminService.getWalletAccounts(page, limit, search);
  }

  @Get('wallets/ledger')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'List the immutable token ledger' })
  async getWalletLedger(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 25,
    @Query('search') search?: string,
    @Query('type') type?: string,
  ) {
    return this.adminService.getWalletLedger(page, limit, search, type);
  }

  @Post('wallets/:userId/adjustments')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Apply an audited token balance adjustment' })
  async adjustWallet(
    @Request() req: AuthenticatedAdminRequest,
    @Param('userId') userId: string,
    @Body() dto: AdminWalletAdjustmentDto,
  ) {
    return this.adminService.adjustWallet(
      req.user.userId,
      userId,
      dto.amount,
      dto.reason,
      dto.requestId,
    );
  }

  @Get('referrals/accounts')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'List referral accounts and global balances' })
  getReferralAccounts(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 25,
    @Query('search') search?: string,
  ) {
    return this.adminReferralsService.getAccounts(page, limit, search);
  }

  @Get('referrals/rewards')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'List referral rewards and commissions' })
  getReferralRewards(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 25,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.adminReferralsService.getRewards(page, limit, search, status);
  }

  @Get('referrals/withdrawals')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'List referral withdrawal requests' })
  getReferralWithdrawals(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 25,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.adminReferralsService.getWithdrawals(
      page,
      limit,
      search,
      status,
    );
  }

  @Post('referrals/withdrawals/:withdrawalId/reconcile')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(5, 60000)
  @ApiOperation({ summary: 'Reconcile a referral withdrawal with FlexPay' })
  reconcileReferralWithdrawal(
    @Request() req: AuthenticatedAdminRequest,
    @Param('withdrawalId') withdrawalId: string,
  ) {
    return this.adminReferralsService.reconcileWithdrawal(
      req.user.userId,
      withdrawalId,
    );
  }

  @Get('users/:userId/details')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary:
      'Get a full admin view of a user, including trips, bookings, trip requests and payments',
  })
  async getUserDetails(@Param('userId') userId: string) {
    return this.adminService.getUserDetails(userId);
  }

  @Put('users/:userId/suspend')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000) // 10 requests per minute per IP
  @ApiOperation({ summary: 'Suspend a user' })
  async suspendUser(@Request() req, @Param('userId') userId: string) {
    return this.adminService.suspendUser(userId, req.user.userId);
  }

  @Put('users/:userId/activate')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000) // 10 requests per minute per IP
  @ApiOperation({ summary: 'Activate a user' })
  async activateUser(@Request() req, @Param('userId') userId: string) {
    return this.adminService.activateUser(userId, req.user.userId);
  }

  @Put('users/:userId/deactivate')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Deactivate a user account' })
  async deactivateUser(@Request() req, @Param('userId') userId: string) {
    return this.adminService.suspendUser(userId, req.user.userId);
  }

  @Get('trips')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000) // 30 requests per minute per IP
  @ApiOperation({ summary: 'Get all trips (paginated)' })
  async getAllTrips(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ) {
    return this.adminService.getAllTrips(page, limit);
  }

  @Put('trips/:tripId')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Update a trip as admin' })
  async updateTrip(
    @Request() req,
    @Param('tripId') tripId: string,
    @Body() updateTripDto: UpdateTripDto,
  ) {
    return this.adminService.updateTrip(tripId, req.user.userId, updateTripDto);
  }

  @Put('trips/:tripId/deactivate')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Deactivate/cancel a trip as admin' })
  async deactivateTrip(@Request() req, @Param('tripId') tripId: string) {
    return this.adminService.deactivateTrip(tripId, req.user.userId);
  }

  @Delete('trips/:tripId')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Delete a trip as admin' })
  async deleteTrip(@Request() req, @Param('tripId') tripId: string) {
    await this.adminService.deleteTrip(tripId, req.user.userId);
    return { message: 'Trip deleted successfully' };
  }

  @Get('bookings')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get all bookings as admin' })
  async getAllBookings(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
    @Query('status') status?: BookingStatus,
  ) {
    return this.adminService.getAllBookings(page, limit, status);
  }

  @Put('bookings/:bookingId/accept')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Accept a booking as admin' })
  async acceptBooking(@Request() req, @Param('bookingId') bookingId: string) {
    return this.adminService.acceptBooking(bookingId, req.user.userId);
  }

  @Put('bookings/:bookingId/reject')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Reject a booking as admin' })
  async rejectBooking(
    @Request() req,
    @Param('bookingId') bookingId: string,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.rejectBooking(bookingId, req.user.userId, reason);
  }

  @Put('bookings/:bookingId/cancel')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Cancel a booking as admin' })
  async cancelBooking(@Request() req, @Param('bookingId') bookingId: string) {
    return this.adminService.cancelBooking(bookingId, req.user.userId);
  }

  @Get('trip-requests')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get all trip requests as admin' })
  async getAllTripRequests(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 50,
    @Query('status') status?: string,
  ) {
    return this.adminService.getAllTripRequests(page, limit, status);
  }

  @Get('trip-requests/:tripRequestId')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get one trip request as admin' })
  async getTripRequest(@Param('tripRequestId') tripRequestId: string) {
    return this.adminService.getTripRequest(tripRequestId);
  }

  @Put('trip-requests/:tripRequestId')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Update a trip request as admin' })
  async updateTripRequest(
    @Request() req,
    @Param('tripRequestId') tripRequestId: string,
    @Body() updateTripRequestDto: UpdateTripRequestDto,
  ) {
    return this.adminService.updateTripRequest(
      tripRequestId,
      req.user.userId,
      updateTripRequestDto,
    );
  }

  @Put('trip-requests/:tripRequestId/deactivate')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Deactivate/cancel a trip request as admin' })
  async deactivateTripRequest(
    @Request() req,
    @Param('tripRequestId') tripRequestId: string,
  ) {
    return this.adminService.deactivateTripRequest(
      tripRequestId,
      req.user.userId,
    );
  }

  @Delete('trip-requests/:tripRequestId')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Delete a trip request as admin' })
  async deleteTripRequest(
    @Request() req,
    @Param('tripRequestId') tripRequestId: string,
  ) {
    await this.adminService.deleteTripRequest(tripRequestId, req.user.userId);
    return { message: 'Trip request deleted successfully' };
  }
}
