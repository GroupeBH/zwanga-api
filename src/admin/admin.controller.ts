import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
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
import { CreateAdminAccountDto, ResetAdminAccountPasswordDto } from './dto/admin-account.dto';
import { spreadsheetHeaders, type SpreadsheetFile } from './spreadsheet';

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

  private sendSpreadsheet(res: Response, file: SpreadsheetFile) {
    res.set(spreadsheetHeaders(file));
    return new StreamableFile(file.buffer);
  }

  @Get('kyc/pending')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000) // 30 requests per minute per IP
  @ApiOperation({ summary: 'Get all pending KYC verifications' })
  async getPendingKycs(@Request() req) {
    return this.adminService.getPendingKycs();
  }

  @Get('kyc')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({
    summary: 'List all KYC documents as consultable history, optionally filtered by status',
  })
  async getKycDocuments(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 25,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getKycDocuments(page, limit, status, search);
  }

  @Get('kyc/:kycId')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get one KYC document with user details' })
  async getKycDocument(@Param('kycId', new ParseUUIDPipe()) kycId: string) {
    return this.adminService.getKycDocument(kycId);
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

  @Get('users/stats')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get platform user counts by role' })
  async getUserStats() {
    return this.adminService.getUserStats();
  }

  @Get('users')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000) // 30 requests per minute per IP
  @ApiOperation({ summary: 'Get all users (paginated)' })
  async getAllUsers(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
    @Query('role') role?: string,
  ) {
    return this.adminService.getAllUsers(page, limit, role);
  }

  @Get('users/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({
    summary:
      'Export users as an Excel .xls spreadsheet, optionally filtered by driver role',
  })
  async exportUsers(
    @Res({ passthrough: true }) res: Response,
    @Query('role') role?: string,
  ) {
    const file = await this.adminService.exportUsersXls(role);
    return this.sendSpreadsheet(res, file);
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

  @Put('accounts/:userId/deactivate')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Deactivate a back-office administrator account' })
  async deactivateAdminAccount(
    @Request() req: AuthenticatedAdminRequest,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.adminService.deactivateAdminAccount(req.user.userId, userId);
  }

  @Put('accounts/:userId/activate')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Reactivate a back-office administrator account' })
  async activateAdminAccount(
    @Request() req: AuthenticatedAdminRequest,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.adminService.activateAdminAccount(req.user.userId, userId);
  }

  @Put('accounts/:userId/password')
  @Auth()
  @Roles(UserRole.SUPER_ADMIN)
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Set a temporary password for a back-office administrator account',
  })
  async resetAdminAccountPassword(
    @Request() req: AuthenticatedAdminRequest,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: ResetAdminAccountPasswordDto,
  ) {
    return this.adminService.resetAdminAccountPassword(
      req.user.userId,
      userId,
      dto.newPassword,
    );
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

  @Get('wallets/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Export token wallet balances as Excel .xls' })
  async exportWalletAccounts(
    @Res({ passthrough: true }) res: Response,
    @Query('search') search?: string,
  ) {
    const file = await this.adminService.exportWalletAccountsXls(search);
    return this.sendSpreadsheet(res, file);
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

  @Get('wallets/ledger/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Export the token ledger as Excel .xls' })
  async exportWalletLedger(
    @Res({ passthrough: true }) res: Response,
    @Query('search') search?: string,
    @Query('type') type?: string,
  ) {
    const file = await this.adminService.exportWalletLedgerXls(search, type);
    return this.sendSpreadsheet(res, file);
  }

  @Get('payments')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'List payment transactions' })
  async getAllPayments(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 25,
    @Query('status') status?: string,
    @Query('purpose') purpose?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getAllPayments(page, limit, status, purpose, search);
  }

  @Get('payments/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Export payment transactions as Excel .xls' })
  async exportPayments(
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
    @Query('purpose') purpose?: string,
    @Query('search') search?: string,
  ) {
    const file = await this.adminService.exportPaymentsXls(status, purpose, search);
    return this.sendSpreadsheet(res, file);
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

  @Get('referrals/accounts/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Export referral accounts as Excel .xls' })
  async exportReferralAccounts(
    @Res({ passthrough: true }) res: Response,
    @Query('search') search?: string,
  ) {
    const file = await this.adminReferralsService.exportAccounts(search);
    return this.sendSpreadsheet(res, file);
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

  @Get('referrals/rewards/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Export referral rewards as Excel .xls' })
  async exportReferralRewards(
    @Res({ passthrough: true }) res: Response,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    const file = await this.adminReferralsService.exportRewards(search, status);
    return this.sendSpreadsheet(res, file);
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

  @Get('referrals/withdrawals/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Export referral withdrawals as Excel .xls' })
  async exportReferralWithdrawals(
    @Res({ passthrough: true }) res: Response,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    const file = await this.adminReferralsService.exportWithdrawals(
      search,
      status,
    );
    return this.sendSpreadsheet(res, file);
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

  @Get('trips/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Export trips as Excel .xls' })
  async exportTrips(@Res({ passthrough: true }) res: Response) {
    const file = await this.adminService.exportTripsXls();
    return this.sendSpreadsheet(res, file);
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
    return { message: "Trajet supprimé avec succès." };
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

  @Get('bookings/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Export bookings as Excel .xls' })
  async exportBookings(
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: BookingStatus,
  ) {
    const file = await this.adminService.exportBookingsXls(status);
    return this.sendSpreadsheet(res, file);
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

  @Get('trip-requests/export')
  @Auth()
  @Roles(UserRole.ADMIN)
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Export trip requests as Excel .xls' })
  async exportTripRequests(
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
  ) {
    const file = await this.adminService.exportTripRequestsXls(status);
    return this.sendSpreadsheet(res, file);
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
    return { message: "Demande de trajet supprimée avec succès." };
  }
}
