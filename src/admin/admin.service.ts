import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Point, Repository, SelectQueryBuilder } from 'typeorm';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { BookingsService } from '../bookings/bookings.service';
import { PaymentTransaction } from '../payments/entities/payment-transaction.entity';
import { DriverOffer, DriverOfferStatus } from '../trip-requests/entities/driver-offer.entity';
import {
  TripRequest,
  TripRequestStatus,
} from '../trip-requests/entities/trip-request.entity';
import { UpdateTripRequestDto } from '../trip-requests/dto/trip-request.dto';
import { TripRequestsService } from '../trip-requests/trip-requests.service';
import { Trip, TripStatus } from '../trips/entities/trip.entity';
import { UpdateTripDto } from '../trips/dto/trip.dto';
import { TripsService } from '../trips/trips.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { KycDocument, KycStatus } from '../users/entities/kyc-document.entity';
import {
  WalletAccount,
  WalletAccountType,
} from '../wallet/entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from '../wallet/entities/wallet-ledger-entry.entity';
import { WalletService } from '../wallet/wallet.service';

type Coordinates = [number, number] | null;
type WalletAccountWithUser = WalletAccount & { user?: User | null };
type WalletLedgerEntryWithUser = WalletLedgerEntry & { user?: User | null };

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly maxPageLimit = 200;

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(KycDocument)
    private kycDocumentRepository: Repository<KycDocument>,
    @InjectRepository(Trip)
    private tripRepository: Repository<Trip>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(PaymentTransaction)
    private paymentRepository: Repository<PaymentTransaction>,
    @InjectRepository(WalletAccount)
    private walletAccountRepository: Repository<WalletAccount>,
    @InjectRepository(WalletLedgerEntry)
    private walletLedgerRepository: Repository<WalletLedgerEntry>,
    @InjectRepository(TripRequest)
    private tripRequestRepository: Repository<TripRequest>,
    @InjectRepository(DriverOffer)
    private driverOfferRepository: Repository<DriverOffer>,
    private readonly tripsService: TripsService,
    private readonly bookingsService: BookingsService,
    private readonly tripRequestsService: TripRequestsService,
    private readonly walletService: WalletService,
  ) {}

  async verifyKyc(
    kycId: string,
    adminId: string,
    approved: boolean,
    reason?: string,
  ): Promise<KycDocument> {
    this.logger.log(
      `Admin ${adminId} verifying KYC ${kycId} - Approved: ${approved}`,
    );

    await this.ensureAdmin(adminId, 'Only admins can verify KYC');

    const kycDocument = await this.kycDocumentRepository.findOne({
      where: { id: kycId },
      relations: ['user'],
    });

    if (!kycDocument) {
      this.logger.warn(
        `KYC verification failed: KYC document ${kycId} not found`,
      );
      throw new NotFoundException('KYC document not found');
    }

    kycDocument.status = approved ? KycStatus.APPROVED : KycStatus.REJECTED;
    kycDocument.reviewedBy = adminId;
    kycDocument.reviewedAt = new Date();
    if (reason) {
      kycDocument.rejectionReason = reason;
    }

    if (approved) {
      kycDocument.user.status = UserStatus.ACTIVE;
      await this.userRepository.save(kycDocument.user);
      this.logger.log(
        `KYC ${kycId} approved - User ${kycDocument.user.id} status set to ACTIVE`,
      );
    } else {
      kycDocument.user.status = UserStatus.PENDING_KYC;
      await this.userRepository.save(kycDocument.user);
      this.logger.log(
        `KYC ${kycId} rejected - User ${kycDocument.user.id} status set to PENDING_KYC. Reason: ${reason || 'N/A'}`,
      );
    }

    return this.kycDocumentRepository.save(kycDocument);
  }

  async getPendingKycs(): Promise<KycDocument[]> {
    this.logger.debug('Fetching pending KYC documents');

    const pendingKycs = await this.kycDocumentRepository.find({
      where: { status: KycStatus.PENDING },
      relations: ['user'],
      order: { createdAt: 'ASC' },
    });

    this.logger.debug(`Found ${pendingKycs.length} pending KYC documents`);
    return pendingKycs.map((kycDocument) => ({
      ...kycDocument,
      user: this.sanitizeUser(kycDocument.user),
    })) as KycDocument[];
  }

  async getAllUsers(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ users: Array<Record<string, unknown>>; total: number }> {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    this.logger.debug(
      `Fetching all users - Page: ${pageNumber}, Limit: ${pageSize}`,
    );

    const [users, total] = await this.userRepository.findAndCount({
      skip: (pageNumber - 1) * pageSize,
      take: pageSize,
      order: { createdAt: 'DESC' },
    });

    this.logger.debug(`Fetched ${users.length} users (total: ${total})`);
    return { users: users.map((user) => this.sanitizeUser(user)!), total };
  }

  async getWalletAccounts(
    page: number = 1,
    limit: number = 25,
    search?: string,
  ) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const query = this.walletAccountRepository
      .createQueryBuilder('account')
      .leftJoinAndMapOne(
        'account.user',
        User,
        'walletUser',
        'walletUser.id = account.userId',
      )
      .addSelect([
        'walletUser.id',
        'walletUser.firstName',
        'walletUser.lastName',
        'walletUser.phone',
        'walletUser.email',
        'walletUser.role',
        'walletUser.status',
        'walletUser.isDriver',
        'walletUser.isActive',
      ])
      .where('account.type = :accountType', {
        accountType: WalletAccountType.POINTS,
      });

    this.applyWalletUserSearch(query, search, 'account', 'walletUser');

    const [accounts, total] = await query
      .orderBy('account.updatedAt', 'DESC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    const rawSummary = await this.walletAccountRepository
      .createQueryBuilder('account')
      .select('COUNT(account.id)', 'accounts')
      .addSelect('COALESCE(SUM(account.balance), 0)', 'totalBalance')
      .addSelect(
        'COUNT(account.id) FILTER (WHERE account.balance > 0)',
        'positiveBalances',
      )
      .addSelect(
        'COUNT(account.id) FILTER (WHERE account.balance < 0)',
        'negativeBalances',
      )
      .where('account.type = :accountType', {
        accountType: WalletAccountType.POINTS,
      })
      .getRawOne<{
        accounts: string;
        totalBalance: string;
        positiveBalances: string;
        negativeBalances: string;
      }>();

    return {
      accounts: (accounts as WalletAccountWithUser[]).map((account) =>
        this.serializeWalletAccount(account),
      ),
      total,
      page: pageNumber,
      limit: pageSize,
      summary: {
        accounts: Number(rawSummary?.accounts ?? 0),
        totalBalance: Number(rawSummary?.totalBalance ?? 0),
        positiveBalances: Number(rawSummary?.positiveBalances ?? 0),
        negativeBalances: Number(rawSummary?.negativeBalances ?? 0),
        currency: 'PTS',
      },
    };
  }

  async getWalletLedger(
    page: number = 1,
    limit: number = 25,
    search?: string,
    requestedType?: string,
  ) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const entryType = this.normalizeWalletEntryType(requestedType);
    const query = this.walletLedgerRepository
      .createQueryBuilder('entry')
      .leftJoinAndMapOne(
        'entry.user',
        User,
        'walletUser',
        'walletUser.id = entry.userId',
      )
      .addSelect([
        'walletUser.id',
        'walletUser.firstName',
        'walletUser.lastName',
        'walletUser.phone',
        'walletUser.email',
        'walletUser.role',
        'walletUser.status',
        'walletUser.isDriver',
        'walletUser.isActive',
      ])
      .where('entry.accountType = :accountType', {
        accountType: WalletAccountType.POINTS,
      });

    if (entryType) {
      query.andWhere('entry.type = :entryType', { entryType });
    }
    this.applyWalletUserSearch(query, search, 'entry', 'walletUser');

    const [entries, total] = await query
      .orderBy('entry.createdAt', 'DESC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      entries: (entries as WalletLedgerEntryWithUser[]).map((entry) =>
        this.serializeWalletLedgerEntry(entry),
      ),
      total,
      page: pageNumber,
      limit: pageSize,
    };
  }

  async adjustWallet(
    adminId: string,
    userId: string,
    amount: number,
    reason: string,
    requestId: string,
  ) {
    await this.ensureAdmin(adminId, 'Only admins can adjust a wallet balance');
    const account = await this.walletService.applyAdminAdjustment(
      adminId,
      userId,
      amount,
      reason,
      requestId,
    );
    const user = await this.userRepository.findOne({ where: { id: userId } });
    return this.serializeWalletAccount({ ...account, user });
  }

  async getUserDetails(userId: string) {
    this.logger.debug(`Fetching admin user details for ${userId}`);

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [
      trips,
      bookingsAsPassenger,
      bookingsAsDriver,
      payments,
      tripRequests,
    ] = await Promise.all([
      this.tripRepository.find({
        where: { driverId: userId },
        relations: ['driver', 'vehicle', 'bookings', 'bookings.passenger'],
        order: { createdAt: 'DESC' },
      }),
      this.bookingRepository.find({
        where: { passengerId: userId },
        relations: ['passenger', 'trip', 'trip.driver', 'paymentTransaction'],
        order: { createdAt: 'DESC' },
      }),
      this.bookingRepository
        .createQueryBuilder('booking')
        .leftJoinAndSelect('booking.passenger', 'passenger')
        .leftJoinAndSelect('booking.trip', 'trip')
        .leftJoinAndSelect('trip.driver', 'driver')
        .leftJoinAndSelect('booking.paymentTransaction', 'paymentTransaction')
        .where('trip.driverId = :userId', { userId })
        .orderBy('booking.createdAt', 'DESC')
        .getMany(),
      this.paymentRepository.find({
        where: { userId },
        order: { createdAt: 'DESC' },
      }),
      this.tripRequestRepository.find({
        where: { passengerId: userId },
        order: { createdAt: 'DESC' },
      }),
    ]);

    const detailedTripRequests = await Promise.all(
      tripRequests.map((tripRequest) =>
        this.tripRequestsService.findOne(tripRequest.id, tripRequest.passengerId),
      ),
    );

    return {
      user: this.sanitizeUser(user),
      trips: trips.map((trip) => this.sanitizeTrip(trip, true)),
      bookingsAsPassenger: bookingsAsPassenger.map((booking) =>
        this.sanitizeBooking(booking),
      ),
      bookingsAsDriver: bookingsAsDriver.map((booking) =>
        this.sanitizeBooking(booking),
      ),
      payments: payments.map((payment) => this.sanitizePayment(payment)),
      tripRequests: detailedTripRequests,
      stats: {
        trips: trips.length,
        bookingsAsPassenger: bookingsAsPassenger.length,
        bookingsAsDriver: bookingsAsDriver.length,
        payments: payments.length,
        tripRequests: tripRequests.length,
        succeededPaymentsAmount: payments
          .filter((payment) => payment.status === 'succeeded')
          .reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
      },
    };
  }

  async suspendUser(userId: string, adminId: string) {
    this.logger.warn(`Admin ${adminId} suspending user ${userId}`);

    await this.ensureAdmin(adminId, 'Only admins can suspend users');

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`User suspension failed: User ${userId} not found`);
      throw new NotFoundException('User not found');
    }

    user.status = UserStatus.SUSPENDED;
    user.isActive = false;
    user.accessToken = null;
    user.refreshToken = null;
    user.fcmToken = null;
    const suspendedUser = await this.userRepository.save(user);

    this.logger.warn(`User ${userId} suspended by admin ${adminId}`);
    return this.sanitizeUser(suspendedUser);
  }

  async activateUser(userId: string, adminId: string) {
    this.logger.log(`Admin ${adminId} activating user ${userId}`);

    await this.ensureAdmin(adminId, 'Only admins can activate users');

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`User activation failed: User ${userId} not found`);
      throw new NotFoundException('User not found');
    }

    user.status = UserStatus.ACTIVE;
    user.isActive = true;
    const activatedUser = await this.userRepository.save(user);

    this.logger.log(`User ${userId} activated by admin ${adminId}`);
    return this.sanitizeUser(activatedUser);
  }

  async getAllTrips(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ trips: Array<Record<string, unknown>>; total: number }> {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    this.logger.debug(
      `Fetching all trips - Page: ${pageNumber}, Limit: ${pageSize}`,
    );

    const [trips, total] = await this.tripRepository.findAndCount({
      skip: (pageNumber - 1) * pageSize,
      take: pageSize,
      relations: ['driver', 'vehicle', 'bookings', 'bookings.passenger'],
      order: { createdAt: 'DESC' },
    });

    this.logger.debug(`Fetched ${trips.length} trips (total: ${total})`);
    return { trips: trips.map((trip) => this.sanitizeTrip(trip, true)), total };
  }

  async updateTrip(tripId: string, adminId: string, updateTripDto: UpdateTripDto) {
    await this.ensureAdmin(adminId, 'Only admins can update trips');
    const trip = await this.findTripOrFail(tripId);

    this.logger.warn(`Admin ${adminId} updating trip ${tripId}`);
    return this.tripsService.update(tripId, trip.driverId, updateTripDto);
  }

  async deactivateTrip(tripId: string, adminId: string) {
    return this.updateTrip(tripId, adminId, {
      status: TripStatus.CANCELLED,
    } as UpdateTripDto);
  }

  async deleteTrip(tripId: string, adminId: string): Promise<void> {
    await this.ensureAdmin(adminId, 'Only admins can delete trips');
    const trip = await this.findTripOrFail(tripId);

    this.logger.warn(`Admin ${adminId} deleting trip ${tripId}`);
    await this.tripsService.remove(tripId, trip.driverId);
  }

  async getAllBookings(
    page: number = 1,
    limit: number = 10,
    status?: BookingStatus | string,
  ) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const statusFilter = this.normalizeBookingStatus(status);

    const [bookings, total] = await this.bookingRepository.findAndCount({
      where: statusFilter ? { status: statusFilter } : {},
      skip: (pageNumber - 1) * pageSize,
      take: pageSize,
      relations: ['passenger', 'trip', 'trip.driver', 'paymentTransaction'],
      order: { createdAt: 'DESC' },
    });

    return {
      bookings: bookings.map((booking) => this.sanitizeBooking(booking)),
      total,
      page: pageNumber,
      limit: pageSize,
    };
  }

  async acceptBooking(bookingId: string, adminId: string) {
    await this.ensureAdmin(adminId, 'Only admins can accept bookings');
    const booking = await this.findBookingOrFail(bookingId);

    if (!booking.trip?.driverId) {
      throw new BadRequestException('Booking trip driver is missing');
    }

    this.logger.warn(`Admin ${adminId} accepting booking ${bookingId}`);
    const accepted = await this.bookingsService.acceptBooking(
      bookingId,
      booking.trip.driverId,
    );
    return this.sanitizeBooking(accepted);
  }

  async rejectBooking(bookingId: string, adminId: string, reason?: string) {
    await this.ensureAdmin(adminId, 'Only admins can reject bookings');
    const booking = await this.findBookingOrFail(bookingId);

    if (!booking.trip?.driverId) {
      throw new BadRequestException('Booking trip driver is missing');
    }

    this.logger.warn(`Admin ${adminId} rejecting booking ${bookingId}`);
    const rejected = await this.bookingsService.rejectBooking(
      bookingId,
      booking.trip.driverId,
      reason?.trim() || 'Rejet effectue par un administrateur',
    );
    return this.sanitizeBooking(rejected);
  }

  async cancelBooking(bookingId: string, adminId: string) {
    await this.ensureAdmin(adminId, 'Only admins can cancel bookings');
    const booking = await this.findBookingOrFail(bookingId);

    this.logger.warn(`Admin ${adminId} cancelling booking ${bookingId}`);
    await this.bookingsService.cancel(bookingId, booking.passengerId);

    const updated = await this.findBookingOrFail(bookingId);
    return this.sanitizeBooking(updated);
  }

  async getAllTripRequests(
    page: number = 1,
    limit: number = 50,
    status?: string,
  ) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const statusFilter = this.normalizeTripRequestStatus(status);

    const [tripRequests, total] = await this.tripRequestRepository.findAndCount({
      where: statusFilter ? { status: statusFilter } : {},
      skip: (pageNumber - 1) * pageSize,
      take: pageSize,
      order: { createdAt: 'DESC' },
    });

    const sanitizedRequests = await Promise.all(
      tripRequests.map((tripRequest) =>
        this.tripRequestsService.findOne(tripRequest.id, tripRequest.passengerId),
      ),
    );

    return {
      tripRequests: sanitizedRequests,
      total,
      page: pageNumber,
      limit: pageSize,
    };
  }

  async getTripRequest(tripRequestId: string) {
    const tripRequest = await this.findTripRequestOrFail(tripRequestId);
    return this.tripRequestsService.findOne(tripRequest.id, tripRequest.passengerId);
  }

  async updateTripRequest(
    tripRequestId: string,
    adminId: string,
    updateTripRequestDto: UpdateTripRequestDto,
  ) {
    await this.ensureAdmin(adminId, 'Only admins can update trip requests');
    const tripRequest = await this.findTripRequestOrFail(tripRequestId);

    this.logger.warn(`Admin ${adminId} updating trip request ${tripRequestId}`);
    return this.tripRequestsService.update(
      tripRequest.passengerId,
      tripRequestId,
      updateTripRequestDto,
    );
  }

  async deactivateTripRequest(tripRequestId: string, adminId: string) {
    await this.ensureAdmin(adminId, 'Only admins can deactivate trip requests');
    const tripRequest = await this.findTripRequestOrFail(tripRequestId);

    this.logger.warn(
      `Admin ${adminId} deactivating trip request ${tripRequestId}`,
    );
    tripRequest.status = TripRequestStatus.CANCELLED;
    await this.tripRequestRepository.save(tripRequest);
    await this.driverOfferRepository.update(
      { tripRequestId, status: In([DriverOfferStatus.PENDING]) },
      { status: DriverOfferStatus.CANCELLED },
    );

    return this.getTripRequest(tripRequestId);
  }

  async deleteTripRequest(tripRequestId: string, adminId: string): Promise<void> {
    await this.ensureAdmin(adminId, 'Only admins can delete trip requests');
    await this.findTripRequestOrFail(tripRequestId);

    this.logger.warn(`Admin ${adminId} deleting trip request ${tripRequestId}`);
    await this.driverOfferRepository.delete({ tripRequestId });
    await this.tripRequestRepository.delete({ id: tripRequestId });
  }

  private async ensureAdmin(adminId: string, message: string): Promise<void> {
    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      this.logger.warn(`Admin action failed: User ${adminId} is not an admin`);
      throw new ForbiddenException(message);
    }
  }

  private async findTripOrFail(tripId: string): Promise<Trip> {
    const trip = await this.tripRepository.findOne({ where: { id: tripId } });
    if (!trip) {
      throw new NotFoundException('Trip not found');
    }
    return trip;
  }

  private async findBookingOrFail(bookingId: string): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['passenger', 'trip', 'trip.driver', 'paymentTransaction'],
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return booking;
  }

  private async findTripRequestOrFail(tripRequestId: string): Promise<TripRequest> {
    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
    });
    if (!tripRequest) {
      throw new NotFoundException('Trip request not found');
    }
    return tripRequest;
  }

  private normalizePagination(page: number, limit: number) {
    const pageNumber = Math.max(Number(page) || 1, 1);
    const requestedLimit = Math.max(Number(limit) || 10, 1);
    return {
      pageNumber,
      pageSize: Math.min(requestedLimit, this.maxPageLimit),
    };
  }

  private applyWalletUserSearch<T extends object>(
    query: SelectQueryBuilder<T>,
    search: string | undefined,
    rootAlias: 'account' | 'entry',
    userAlias: 'walletUser',
  ): void {
    const normalizedSearch = search?.trim();
    if (!normalizedSearch) {
      return;
    }

    query.andWhere(
      `(
        CAST(${rootAlias}.userId AS TEXT) ILIKE :walletSearch
        OR ${userAlias}.firstName ILIKE :walletSearch
        OR ${userAlias}.lastName ILIKE :walletSearch
        OR ${userAlias}.phone ILIKE :walletSearch
        OR ${userAlias}.email ILIKE :walletSearch
      )`,
      { walletSearch: `%${normalizedSearch.slice(0, 160)}%` },
    );
  }

  private normalizeWalletEntryType(
    requestedType?: string,
  ): WalletLedgerEntryType | undefined {
    if (!requestedType || requestedType === 'all') {
      return undefined;
    }
    if (
      !Object.values(WalletLedgerEntryType).includes(
        requestedType as WalletLedgerEntryType,
      )
    ) {
      throw new BadRequestException("Type d'ecriture de portefeuille invalide");
    }
    return requestedType as WalletLedgerEntryType;
  }

  private serializeWalletAccount(account: WalletAccountWithUser) {
    return {
      id: account.id,
      userId: account.userId,
      type: account.type,
      balance: Number(account.balance),
      currency: account.currency,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      user: this.sanitizeUser(account.user),
    };
  }

  private serializeWalletLedgerEntry(entry: WalletLedgerEntryWithUser) {
    return {
      id: entry.id,
      accountId: entry.accountId,
      userId: entry.userId,
      accountType: entry.accountType,
      type: entry.type,
      amount: Number(entry.amount),
      balanceAfter: Number(entry.balanceAfter),
      currency: entry.currency,
      relatedEntityType: entry.relatedEntityType,
      relatedEntityId: entry.relatedEntityId,
      paymentTransactionId: entry.paymentTransactionId,
      description: entry.description,
      createdAt: entry.createdAt,
      user: this.sanitizeUser(entry.user),
    };
  }

  private normalizeBookingStatus(status?: BookingStatus | string) {
    if (!status || status === 'all') {
      return undefined;
    }
    return Object.values(BookingStatus).includes(status as BookingStatus)
      ? (status as BookingStatus)
      : undefined;
  }

  private normalizeTripRequestStatus(status?: string) {
    if (!status || status === 'all') {
      return undefined;
    }
    return Object.values(TripRequestStatus).includes(status as TripRequestStatus)
      ? (status as TripRequestStatus)
      : undefined;
  }

  private sanitizeUser(user?: User | null) {
    if (!user) {
      return null;
    }

    const {
      password: _password,
      accessToken: _accessToken,
      refreshToken: _refreshToken,
      googleId: _googleId,
      appleId: _appleId,
      fcmToken: _fcmToken,
      vehicles: _vehicles,
      trips: _trips,
      bookings: _bookings,
      receivedRatings: _receivedRatings,
      givenRatings: _givenRatings,
      sentMessages: _sentMessages,
      conversationParticipants: _conversationParticipants,
      subscriptions: _subscriptions,
      kycDocuments: _kycDocuments,
      favoriteLocations: _favoriteLocations,
      ...safeUser
    } = user;

    return safeUser;
  }

  private sanitizeTrip(trip?: Trip | null, includeBookings = false) {
    if (!trip) {
      return null;
    }

    const {
      driver,
      bookings,
      departurePoint,
      arrivalPoint,
      currentLocation,
      vehicle,
      ...rest
    } = trip;

    return {
      ...rest,
      pricePerSeat: Number(trip.pricePerSeat ?? 0),
      departureCoordinates: this.pointToCoordinates(departurePoint),
      arrivalCoordinates: this.pointToCoordinates(arrivalPoint),
      currentLocation: this.pointToCoordinates(currentLocation),
      driver: this.sanitizeUser(driver),
      vehicle: vehicle ?? null,
      bookings: includeBookings
        ? bookings?.map((booking) => this.sanitizeBooking(booking, false)) ?? []
        : undefined,
    };
  }

  private sanitizeBooking(booking: Booking, includeTrip = true) {
    const {
      passenger,
      trip,
      messages: _messages,
      paymentTransaction,
      passengerOriginPoint,
      passengerDestinationPoint,
      passengerCurrentLocation,
      ...rest
    } = booking;

    return {
      ...rest,
      paymentAmount:
        booking.paymentAmount === null ? null : Number(booking.paymentAmount),
      passengerOriginCoordinates: this.pointToCoordinates(passengerOriginPoint),
      passengerDestinationCoordinates: this.pointToCoordinates(
        passengerDestinationPoint,
      ),
      passengerCurrentLocation: this.pointToCoordinates(passengerCurrentLocation),
      passenger: this.sanitizeUser(passenger),
      trip: includeTrip ? this.sanitizeTrip(trip) : undefined,
      paymentTransaction: this.sanitizePayment(paymentTransaction),
    };
  }

  private sanitizePayment(payment?: PaymentTransaction | null) {
    if (!payment) {
      return null;
    }

    const {
      rawInitiationResponse: _rawInitiationResponse,
      rawCallbackPayload: _rawCallbackPayload,
      rawCheckResponse: _rawCheckResponse,
      ...safePayment
    } = payment;

    return {
      ...safePayment,
      amount: Number(payment.amount ?? 0),
    };
  }

  private pointToCoordinates(point?: Point | null): Coordinates {
    if (!point?.coordinates || point.coordinates.length < 2) {
      return null;
    }

    return [Number(point.coordinates[0]), Number(point.coordinates[1])];
  }
}
