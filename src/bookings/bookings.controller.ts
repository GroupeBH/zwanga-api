import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { BookingsService } from './bookings.service';
import { CreateBookingDto, UpdateBookingStatusDto, RejectBookingDto, ConfirmPickupDto, ConfirmDropoffDto, ReportBookingProblemDto, UpdatePassengerLocationDto, UpdateBookingPaymentModeDto } from './dto/booking.dto';
import { SendWhatsAppNotificationDto } from './dto/send-whatsapp-notification.dto';
import { Auth } from '../auth/decorators/auth.decorator';
import { SensitiveThrottle } from '../common/decorators/sensitive-throttle.decorator';
import { Public } from '../common/decorators/public.decorator';
import { FlexPayCallbackDto, InitiatePaymentDto } from '../payments/dto/payment.dto';

@ApiTags('Bookings')
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) { }

  @Post('flexpay/callback')
  @Public()
  @SensitiveThrottle(120, 60000)
  @ApiOperation({ summary: 'Receive FlexPay payment callback for trip bookings' })
  async handleFlexPayCallback(@Body() dto: FlexPayCallbackDto) {
    return this.bookingsService.handleFlexPayCallback(dto);
  }

  @Post()
  @Auth()
  // @Roles(UserRole.PASSENGER)
  @SensitiveThrottle(10, 60000) // 10 requests per minute per IP
  @ApiOperation({
    summary: 'Create a new booking',
    description:
      "La reservation d'un trajet par un passager ne requiert pas un KYC approuve. Seul un compte suspendu est bloque via l'authentification.",
  })
  async create(@Request() req, @Body() createBookingDto: CreateBookingDto) {
    return this.bookingsService.create(req.user.userId, createBookingDto);
  }

  @Post(':id/pay')
  @Auth()
  @SensitiveThrottle(5, 60000)
  @ApiOperation({
    summary: 'Initiate electronic payment for a booking',
    description:
      "Calcule le montant cote backend a partir du prix du trajet et du nombre de places, puis initialise le paiement FlexPay.",
  })
  async initiatePayment(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: InitiatePaymentDto,
  ) {
    return this.bookingsService.initiateBookingPayment(
      id,
      req.user.userId,
      dto,
    );
  }

  @Put(':id/payment-mode')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({
    summary: 'Update payment mode for a booking',
    description:
      'Permet au passager de changer entre paiement electronique, points Zwanga et paiement physique avant la cloture de la reservation.',
  })
  async updatePaymentMode(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: UpdateBookingPaymentModeDto,
  ) {
    return this.bookingsService.updatePaymentMode(
      id,
      req.user.userId,
      dto.paymentMode,
    );
  }

  @Get('payments/:orderNumber/status')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({
    summary: 'Check a trip booking payment status and update the booking',
  })
  async checkPaymentStatus(
    @Request() req,
    @Param('orderNumber') orderNumber: string,
  ) {
    return this.bookingsService.checkBookingPaymentStatus(
      req.user.userId,
      orderNumber,
    );
  }

  @Get('my-bookings')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Get all bookings of the current user' })
  async findMyBookings(@Request() req) {
    return this.bookingsService.findAllByPassenger(req.user.userId);
  }

  @Get('trip/:tripId')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Get all bookings for a trip (driver only)' })
  async findByTrip(@Request() req, @Param('tripId') tripId: string) {
    return this.bookingsService.findAllByTrip(tripId, req.user.userId);
  }

  @Get(':id')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get a booking by ID' })
  async findOne(@Param('id') id: string) {
    return this.bookingsService.findOne(id);
  }

  @Put(':id/status')
  @Auth()
  // @Roles(UserRole.DRIVER)
  @SensitiveThrottle(20, 60000) // 20 requests per minute per IP
  @ApiOperation({ summary: 'Update booking status (driver only)' })
  async updateStatus(
    @Request() req,
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateBookingStatusDto,
  ) {
    return this.bookingsService.updateStatus(id, req.user.userId, updateStatusDto);
  }

  @Put(':id/accept')
  @Auth()
  // @Roles(UserRole.DRIVER)
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Accept a booking (driver only)' })
  async accept(@Request() req, @Param('id') id: string) {
    return this.bookingsService.acceptBooking(id, req.user.userId);
  }

  @Put(':id/reject')
  @Auth()
  // @Roles(UserRole.DRIVER)
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Reject a booking with a reason (driver only)' })
  async reject(
    @Request() req,
    @Param('id') id: string,
    @Body() rejectBookingDto: RejectBookingDto,
  ) {
    return this.bookingsService.rejectBooking(id, req.user.userId, rejectBookingDto.reason);
  }

  @Put(':id/cancel')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Cancel a booking (passenger or driver before pickup)' })
  async cancel(@Request() req, @Param('id') id: string) {
    await this.bookingsService.cancel(id, req.user.userId);
    return { message: 'Booking cancelled successfully' };
  }

  @Get(':id/driver-contact')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get driver contact information for a booking' })
  async getDriverContact(@Request() req, @Param('id') id: string) {
    return this.bookingsService.getDriverContact(id, req.user.userId);
  }

  @Post(':id/whatsapp-notification-data')
  @Auth()
  @SensitiveThrottle(10, 60000) // Limiter à 10 requêtes par minute
  @ApiOperation({
    summary: 'Récupérer les données pour envoyer des notifications WhatsApp aux contacts d\'urgence (2 à 3 contacts)',
    description:
      'Retourne le message formaté et les informations des contacts d\'urgence sélectionnés. Le frontend se charge de l\'envoi WhatsApp.',
  })
  async getWhatsAppNotificationData(
    @Request() req,
    @Param('id') id: string,
    @Body() sendDto: SendWhatsAppNotificationDto,
  ) {
    return this.bookingsService.getWhatsAppNotificationData(
      id,
      req.user.userId,
      sendDto,
    );
  }

  @Put(':id/confirm-pickup')
  @Auth()
  // @Roles(UserRole.DRIVER)
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Confirm passenger pickup (driver only)' })
  async confirmPickup(@Request() req, @Param('id') id: string, @Body() dto: ConfirmPickupDto) {
    return this.bookingsService.confirmPickup(id, req.user.userId);
  }

  @Put(':id/confirm-pickup-passenger')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Confirm pickup by passenger' })
  async confirmPickupByPassenger(@Request() req, @Param('id') id: string, @Body() dto: ConfirmPickupDto) {
    return this.bookingsService.confirmPickupByPassenger(id, req.user.userId);
  }

  @Put(':id/confirm-dropoff')
  @Auth()
  // @Roles(UserRole.DRIVER)
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Confirm passenger-requested dropoff (driver only)' })
  async confirmDropoff(@Request() req, @Param('id') id: string, @Body() dto: ConfirmDropoffDto) {
    return this.bookingsService.confirmDropoff(id, req.user.userId);
  }

  @Put(':id/confirm-dropoff-passenger')
  @Auth()
  @SensitiveThrottle(20, 60000)
  @ApiOperation({ summary: 'Request dropoff by passenger' })
  async confirmDropoffByPassenger(@Request() req, @Param('id') id: string, @Body() dto: ConfirmDropoffDto) {
    return this.bookingsService.confirmDropoffByPassenger(id, req.user.userId, dto);
  }

  @Post(':id/report-problem')
  @Auth()
  @SensitiveThrottle(10, 60000)
  @ApiOperation({ summary: 'Report a problem related to a booking (driver or passenger)' })
  async reportProblem(
    @Request() req,
    @Param('id') id: string,
    @Body() reportDto: ReportBookingProblemDto,
  ) {
    return this.bookingsService.reportBookingProblem(id, req.user.userId, reportDto);
  }

  @Put(':id/passenger-location')
  @Auth()
  @SensitiveThrottle(30, 60000) // 30 updates per minute (frequent updates for tracking)
  @ApiOperation({ summary: 'Update passenger current location (passenger only)' })
  async updatePassengerLocation(
    @Request() req,
    @Param('id') id: string,
    @Body() updateLocationDto: UpdatePassengerLocationDto,
  ) {
    return this.bookingsService.updatePassengerLocation(req.user.userId, id, updateLocationDto);
  }

  @Get('trip/:tripId/passengers-locations')
  @Auth()
  @SensitiveThrottle(30, 60000)
  @ApiOperation({ summary: 'Get all passengers locations for a trip (driver only)' })
  async getPassengersLocations(@Request() req, @Param('tripId') tripId: string) {
    return this.bookingsService.getPassengersLocations(tripId, req.user.userId);
  }
}

