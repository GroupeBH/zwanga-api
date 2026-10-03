import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Point, Repository, SelectQueryBuilder } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Booking, BookingStatus } from '../bookings/entities/booking.entity';
import { BookingsService } from '../bookings/bookings.service';
import {
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
} from '../payments/entities/payment-transaction.entity';
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
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import {
  ADMIN_USER_ROLES,
  assertSuperAdminRole,
  isAdminRole,
  isSuperAdminRole,
} from '../users/user-role.policy';
import {
  WalletAccount,
  WalletAccountType,
} from '../wallet/entities/wallet-account.entity';
import {
  WalletLedgerEntry,
  WalletLedgerEntryType,
} from '../wallet/entities/wallet-ledger-entry.entity';
import { WalletService } from '../wallet/wallet.service';
import { CreateAdminAccountDto } from './dto/admin-account.dto';
import { provisionAdminAccount } from './admin-account.provisioning';
import {
  AdminUserSegment,
  parseAdminUserSegment,
} from './dto/admin-users.dto';
import {
  buildUsersSpreadsheet,
  usersSpreadsheetFilename,
} from './users-spreadsheet';
import {
  applyAdminUserSegmentFilter,
  DriverQualification,
  resolveDriverQualification,
} from './qualified-driver';
import { parseKycStatus } from './dto/admin-kyc.dto';
import { activateRequestedDriver } from '../users/driver-activation';
import {
  buildBookingsSpreadsheet,
  buildPaymentsSpreadsheet,
  buildTripRequestsSpreadsheet,
  buildTripsSpreadsheet,
  buildWalletAccountsSpreadsheet,
  buildWalletLedgerSpreadsheet,
} from './admin-spreadsheets';
import type { SpreadsheetFile } from './spreadsheet';

type Coordinates = [number, number] | null;
type WalletAccountWithUser = WalletAccount & { user?: User | null };
type WalletLedgerEntryWithUser = WalletLedgerEntry & { user?: User | null };
type PaymentWithUser = PaymentTransaction & { user?: User | null };

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
      throw new NotFoundException("Document de vérification d’identité introuvable.");
    }

    kycDocument.status = approved ? KycStatus.APPROVED : KycStatus.REJECTED;
    kycDocument.reviewedBy = adminId;
    kycDocument.reviewedAt = new Date();
    if (reason) {
      kycDocument.rejectionReason = reason;
    }

    return this.userRepository.manager.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({
        where: { id: kycDocument.userId }, lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('Utilisateur introuvable');
      const saved = await manager.getRepository(KycDocument).save(kycDocument);
      if (user.isActive && ![UserStatus.SUSPENDED, UserStatus.INACTIVE].includes(user.status)) {
        await manager.getRepository(User).update(user.id, {
          status: approved ? UserStatus.ACTIVE : UserStatus.PENDING_KYC,
        });
      }
      await activateRequestedDriver(manager, user.id);
      return saved;
    });
  }

  async getPendingKycs(): Promise<KycDocument[]> {
    this.logger.debug('Fetching pending KYC documents');

    const pendingKycs = await this.kycDocumentRepository.find({
      where: { status: KycStatus.PENDING },
      relations: ['user'],
      order: { createdAt: 'ASC' },
    });

    this.logger.debug(`Found ${pendingKycs.length} pending KYC documents`);
    return pendingKycs.map((kycDocument) =>
      this.sanitizeKycDocument(kycDocument),
    ) as KycDocument[];
  }

  async getKycDocuments(
    page: number = 1,
    limit: number = 25,
    status?: string,
    search?: string,
  ) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const statusFilter = parseKycStatus(status);
    this.logger.debug(
      `Fetching KYC history - Page: ${pageNumber}, Limit: ${pageSize}, Status: ${statusFilter ?? 'all'}`,
    );

    const query = this.createKycListQuery(statusFilter, search);
    const [documents, total] = await query
      .orderBy('kyc.createdAt', 'DESC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      documents: documents.map((document) => this.sanitizeKycDocument(document)),
      total,
      page: pageNumber,
      limit: pageSize,
    };
  }

  async getKycDocument(kycId: string) {
    const kycDocument = await this.kycDocumentRepository.findOne({
      where: { id: kycId },
      relations: ['user'],
    });
    if (!kycDocument) {
      throw new NotFoundException("Document de vérification d’identité introuvable.");
    }
    return this.sanitizeKycDocument(kycDocument);
  }

  async getAllUsers(
    page: number = 1,
    limit: number = 10,
    role?: string,
  ): Promise<{ users: Array<Record<string, unknown>>; total: number }> {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const roleFilter = parseAdminUserSegment(role);
    this.logger.debug(
      `Fetching all users - Page: ${pageNumber}, Limit: ${pageSize}, Role: ${roleFilter ?? 'all'}`,
    );

    const query = this.createUsersListQuery(roleFilter)
      .orderBy('user.createdAt', 'DESC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize);

    const [users, total] = await query.getManyAndCount();
    this.logger.debug(`Fetched ${users.length} users (total: ${total})`);
    return {
      users: await this.serializeUsersWithDriverQualification(users),
      total,
    };
  }

  async exportUsersXls(role?: string): Promise<{
    buffer: Buffer;
    filename: string;
    contentType: string;
  }> {
    const roleFilter = parseAdminUserSegment(role);
    this.logger.debug(
      `Exporting users spreadsheet - Role: ${roleFilter ?? 'all'}`,
    );

    const users = await this.createUsersListQuery(roleFilter)
      .orderBy('user.createdAt', 'DESC')
      .getMany();
    const serialized = await this.serializeUsersWithDriverQualification(users);

    return {
      buffer: buildUsersSpreadsheet(serialized),
      filename: usersSpreadsheetFilename(roleFilter),
      contentType: 'application/vnd.ms-excel; charset=utf-8',
    };
  }

  async getUserStats(): Promise<{
    totalUsers: number;
    drivers: number;
    passengers: number;
  }> {
    const [totalUsers, drivers] = await Promise.all([
      this.userRepository
        .createQueryBuilder('user')
        .where('user.role NOT IN (:...adminRoles)', {
          adminRoles: [...ADMIN_USER_ROLES],
        })
        .getCount(),
      applyAdminUserSegmentFilter(
        this.userRepository.createQueryBuilder('user'),
        'driver',
      ).getCount(),
    ]);

    return {
      totalUsers,
      drivers,
      passengers: Math.max(totalUsers - drivers, 0),
    };
  }

  async getAdminAccounts(
    adminId: string,
    page: number = 1,
    limit: number = 25,
  ) {
    await this.ensureSuperAdmin(
      adminId,
      'Only super admins can list back-office accounts',
    );
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);

    const [accounts, total] = await this.userRepository.findAndCount({
      where: { role: In([...ADMIN_USER_ROLES]) },
      skip: (pageNumber - 1) * pageSize,
      take: pageSize,
      order: { createdAt: 'DESC' },
    });

    return {
      accounts: accounts.map((account) => this.serializeAdminAccount(account)),
      total,
      page: pageNumber,
      limit: pageSize,
    };
  }

  async createAdminAccount(
    adminId: string,
    dto: CreateAdminAccountDto,
  ) {
    await this.ensureSuperAdmin(
      adminId,
      'Only super admins can create back-office accounts',
    );

    try {
      const admin = await this.userRepository.manager.transaction(
        async (manager) =>
          provisionAdminAccount(manager.getRepository(User), {
            phone: dto.phone,
            firstName: dto.firstName,
            lastName: dto.lastName,
            password: dto.defaultPassword,
            role: UserRole.ADMIN,
            passwordChangeRequired: true,
            isPhoneVerified: false,
            existingAccountStrategy: 'promote_self_service',
            lockExistingAccount: true,
          }),
      );

      this.logger.warn(
        `Super admin ${adminId} created or promoted admin account ${admin.id}`,
      );

      return this.serializeAdminAccount(admin);
    } catch (error) {
      if (error instanceof Error) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  async deactivateAdminAccount(actorId: string, userId: string) {
    const account = await this.findManagedAdminAccount(actorId, userId);

    account.status = UserStatus.SUSPENDED;
    account.isActive = false;
    account.accessToken = null;
    account.refreshToken = null;
    account.fcmToken = null;
    const saved = await this.userRepository.save(account);

    this.logger.warn(
      `Super admin ${actorId} deactivated admin account ${userId}`,
    );
    return this.serializeAdminAccount(saved);
  }

  async activateAdminAccount(actorId: string, userId: string) {
    const account = await this.findManagedAdminAccount(actorId, userId);

    account.status = UserStatus.ACTIVE;
    account.isActive = true;
    const saved = await this.userRepository.save(account);

    this.logger.warn(
      `Super admin ${actorId} reactivated admin account ${userId}`,
    );
    return this.serializeAdminAccount(saved);
  }

  async resetAdminAccountPassword(
    actorId: string,
    userId: string,
    newPassword: string,
  ) {
    const account = await this.findManagedAdminAccount(actorId, userId);
    const password = newPassword.trim();
    if (password.length < 8 || password.length > 128) {
      throw new BadRequestException(
        'Le mot de passe doit contenir entre 8 et 128 caractères',
      );
    }

    account.password = await bcrypt.hash(password, 12);
    account.passwordChangeRequired = true;
    account.accessToken = null;
    account.refreshToken = null;
    account.fcmToken = null;
    const saved = await this.userRepository.save(account);

    this.logger.warn(
      `Super admin ${actorId} reset password for admin account ${userId}`,
    );
    return this.serializeAdminAccount(saved);
  }

  async getWalletAccounts(
    page: number = 1,
    limit: number = 25,
    search?: string,
  ) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const query = this.createWalletAccountsQuery(search);

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
    const query = this.createWalletLedgerQuery(search, requestedType);

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

  async exportWalletAccountsXls(search?: string): Promise<SpreadsheetFile> {
    const accounts = await this.createWalletAccountsQuery(search)
      .orderBy('account.updatedAt', 'DESC')
      .getMany();
    return buildWalletAccountsSpreadsheet(
      (accounts as WalletAccountWithUser[]).map((account) =>
        this.serializeWalletAccount(account),
      ),
    );
  }

  async exportWalletLedgerXls(
    search?: string,
    requestedType?: string,
  ): Promise<SpreadsheetFile> {
    const entries = await this.createWalletLedgerQuery(search, requestedType)
      .orderBy('entry.createdAt', 'DESC')
      .getMany();
    return buildWalletLedgerSpreadsheet(
      (entries as WalletLedgerEntryWithUser[]).map((entry) =>
        this.serializeWalletLedgerEntry(entry),
      ),
    );
  }

  async getAllPayments(
    page: number = 1,
    limit: number = 25,
    status?: string,
    purpose?: string,
    search?: string,
  ) {
    const { pageNumber, pageSize } = this.normalizePagination(page, limit);
    const query = this.createPaymentsQuery(status, purpose, search);
    const [payments, total] = await query
      .orderBy('payment.createdAt', 'DESC')
      .skip((pageNumber - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      payments: (payments as PaymentWithUser[]).map((payment) =>
        this.serializeAdminPayment(payment),
      ),
      total,
      page: pageNumber,
      limit: pageSize,
      summary: await this.summarizePayments(status, purpose, search),
      source: 'admin-api',
    };
  }

  async exportPaymentsXls(
    status?: string,
    purpose?: string,
    search?: string,
  ): Promise<SpreadsheetFile> {
    const payments = await this.createPaymentsQuery(status, purpose, search)
      .orderBy('payment.createdAt', 'DESC')
      .getMany();
    return buildPaymentsSpreadsheet(
      (payments as PaymentWithUser[]).map((payment) =>
        this.serializeAdminPayment(payment),
      ),
    );
  }

  async adjustWallet(
    adminId: string,
    userId: string,
    amount: number,
    reason: string,
    requestId: string,
  ) {
    await this.ensureSuperAdmin(
      adminId,
      'Only super admins can adjust a wallet balance',
    );
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
      throw new NotFoundException("Utilisateur introuvable.");
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
      user: (await this.serializeUsersWithDriverQualification([user]))[0],
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

    const admin = await this.ensureAdmin(adminId, 'Only admins can suspend users');

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`User suspension failed: User ${userId} not found`);
      throw new NotFoundException("Utilisateur introuvable.");
    }
    if (user.id === adminId) {
      throw new BadRequestException(
        'Un administrateur ne peut pas suspendre son propre compte',
      );
    }
    if (isAdminRole(user.role) && !isSuperAdminRole(admin.role)) {
      throw new ForbiddenException(
        'Seul un super administrateur peut suspendre un compte administrateur',
      );
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

    const admin = await this.ensureAdmin(adminId, 'Only admins can activate users');

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`User activation failed: User ${userId} not found`);
      throw new NotFoundException("Utilisateur introuvable.");
    }
    if (isAdminRole(user.role) && !isSuperAdminRole(admin.role)) {
      throw new ForbiddenException(
        'Seul un super administrateur peut reactiver un compte administrateur',
      );
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

  async exportTripsXls(): Promise<SpreadsheetFile> {
    const trips = await this.tripRepository.find({
      relations: ['driver', 'vehicle'],
      order: { createdAt: 'DESC' },
    });
    return buildTripsSpreadsheet(
      trips.map((trip) => this.sanitizeTrip(trip, false)!),
    );
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

  async exportBookingsXls(status?: BookingStatus | string): Promise<SpreadsheetFile> {
    const statusFilter = this.normalizeBookingStatus(status);
    const bookings = await this.bookingRepository.find({
      where: statusFilter ? { status: statusFilter } : {},
      relations: ['passenger', 'trip', 'trip.driver', 'paymentTransaction'],
      order: { createdAt: 'DESC' },
    });
    return buildBookingsSpreadsheet(
      bookings.map((booking) => this.sanitizeBooking(booking)),
    );
  }

  async acceptBooking(bookingId: string, adminId: string) {
    await this.ensureAdmin(adminId, 'Only admins can accept bookings');
    const booking = await this.findBookingOrFail(bookingId);

    if (!booking.trip?.driverId) {
      throw new BadRequestException("Aucun conducteur n’est associé à cette réservation.");
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
      throw new BadRequestException("Aucun conducteur n’est associé à cette réservation.");
    }

    this.logger.warn(`Admin ${adminId} rejecting booking ${bookingId}`);
    const rejected = await this.bookingsService.rejectBooking(
      bookingId,
      booking.trip.driverId,
      reason?.trim() || 'Rejet effectué par un administrateur',
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

  async exportTripRequestsXls(status?: string): Promise<SpreadsheetFile> {
    const statusFilter = this.normalizeTripRequestStatus(status);
    const tripRequests = await this.tripRequestRepository.find({
      where: statusFilter ? { status: statusFilter } : {},
      relations: ['passenger', 'driverOffers'],
      order: { createdAt: 'DESC' },
    });

    return buildTripRequestsSpreadsheet(
      tripRequests.map((tripRequest) => ({
        id: tripRequest.id,
        departureLocation: tripRequest.departureLocation,
        arrivalLocation: tripRequest.arrivalLocation,
        departureDateMin: tripRequest.departureDateMin,
        departureDateMax: tripRequest.departureDateMax,
        numberOfSeats: tripRequest.numberOfSeats,
        maxPricePerSeat: tripRequest.maxPricePerSeat,
        paymentMode: tripRequest.paymentMode,
        status: tripRequest.status,
        createdAt: tripRequest.createdAt,
        passenger: this.sanitizeUser(tripRequest.passenger),
        driverOffersCount: tripRequest.driverOffers?.length ?? 0,
      })),
    );
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

  private async ensureAdmin(adminId: string, message: string): Promise<User> {
    const admin = await this.userRepository.findOne({ where: { id: adminId } });
    if (!admin || !isAdminRole(admin.role)) {
      this.logger.warn(`Admin action failed: User ${adminId} is not an admin`);
      throw new ForbiddenException(message);
    }
    return admin;
  }

  private async ensureSuperAdmin(
    adminId: string,
    message: string,
  ): Promise<User> {
    const admin = await this.ensureAdmin(adminId, message);
    assertSuperAdminRole(admin.role, message);
    return admin;
  }

  private async findTripOrFail(tripId: string): Promise<Trip> {
    const trip = await this.tripRepository.findOne({ where: { id: tripId } });
    if (!trip) {
      throw new NotFoundException("Trajet introuvable.");
    }
    return trip;
  }

  private async findBookingOrFail(bookingId: string): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['passenger', 'trip', 'trip.driver', 'paymentTransaction'],
    });
    if (!booking) {
      throw new NotFoundException("Réservation introuvable.");
    }
    return booking;
  }

  private async findTripRequestOrFail(tripRequestId: string): Promise<TripRequest> {
    const tripRequest = await this.tripRequestRepository.findOne({
      where: { id: tripRequestId },
    });
    if (!tripRequest) {
      throw new NotFoundException("Demande de trajet introuvable.");
    }
    return tripRequest;
  }

  private async findManagedAdminAccount(actorId: string, userId: string) {
    await this.ensureSuperAdmin(
      actorId,
      'Only super admins can manage back-office accounts',
    );

    if (actorId === userId) {
      throw new BadRequestException(
        'Un super administrateur ne peut pas modifier son propre compte ici',
      );
    }

    const account = await this.userRepository.findOne({ where: { id: userId } });
    if (!account || !isAdminRole(account.role)) {
      throw new NotFoundException('Compte administrateur introuvable.');
    }
    if (isSuperAdminRole(account.role)) {
      throw new ForbiddenException(
        'Un compte super administrateur ne peut pas être modifié depuis cette liste',
      );
    }

    return account;
  }

  private createUsersListQuery(roleFilter?: AdminUserSegment) {
    const query = this.userRepository.createQueryBuilder('user');
    if (!roleFilter) {
      return query;
    }

    return applyAdminUserSegmentFilter(query, roleFilter);
  }

  private createKycListQuery(status?: KycStatus, search?: string) {
    const query = this.kycDocumentRepository
      .createQueryBuilder('kyc')
      .leftJoinAndSelect('kyc.user', 'user');

    if (status) {
      query.andWhere('kyc.status = :status', { status });
    }

    const term = search?.trim().slice(0, 160);
    if (term) {
      query.andWhere(
        `(
          user.firstName ILIKE :kycSearch
          OR user.lastName ILIKE :kycSearch
          OR user.phone ILIKE :kycSearch
          OR user.email ILIKE :kycSearch
        )`,
        { kycSearch: `%${term}%` },
      );
    }

    return query;
  }

  private createWalletAccountsQuery(search?: string) {
    const query = this.walletAccountRepository
      .createQueryBuilder('account')
      .leftJoinAndMapOne(
        'account.user',
        User,
        'walletUser',
        'walletUser.id = account.userId',
      )
      .addSelect(this.adminUserSelect('walletUser'))
      .where('account.type = :accountType', {
        accountType: WalletAccountType.POINTS,
      });
    this.applyWalletUserSearch(query, search, 'account', 'walletUser');
    return query;
  }

  private createWalletLedgerQuery(search?: string, requestedType?: string) {
    const entryType = this.normalizeWalletEntryType(requestedType);
    const query = this.walletLedgerRepository
      .createQueryBuilder('entry')
      .leftJoinAndMapOne(
        'entry.user',
        User,
        'walletUser',
        'walletUser.id = entry.userId',
      )
      .addSelect(this.adminUserSelect('walletUser'))
      .where('entry.accountType = :accountType', {
        accountType: WalletAccountType.POINTS,
      });

    if (entryType) {
      query.andWhere('entry.type = :entryType', { entryType });
    }
    this.applyWalletUserSearch(query, search, 'entry', 'walletUser');
    return query;
  }

  private createPaymentsQuery(
    status?: string,
    purpose?: string,
    search?: string,
  ) {
    const query = this.paymentRepository
      .createQueryBuilder('payment')
      .leftJoinAndMapOne(
        'payment.user',
        User,
        'paymentUser',
        'paymentUser.id = payment.userId',
      )
      .addSelect(this.adminUserSelect('paymentUser'));

    const statusFilter = this.normalizePaymentStatus(status);
    if (statusFilter) {
      query.andWhere('payment.status = :status', { status: statusFilter });
    }

    const purposeFilter = this.normalizePaymentPurpose(purpose);
    if (purposeFilter) {
      query.andWhere('payment.purpose = :purpose', { purpose: purposeFilter });
    }

    const term = search?.trim().slice(0, 160);
    if (term) {
      query.andWhere(
        `(
          payment.reference ILIKE :paymentSearch
          OR payment.orderNumber ILIKE :paymentSearch
          OR payment.providerReference ILIKE :paymentSearch
          OR payment.phone ILIKE :paymentSearch
          OR payment.description ILIKE :paymentSearch
          OR paymentUser.firstName ILIKE :paymentSearch
          OR paymentUser.lastName ILIKE :paymentSearch
          OR paymentUser.phone ILIKE :paymentSearch
          OR paymentUser.email ILIKE :paymentSearch
        )`,
        { paymentSearch: `%${term}%` },
      );
    }

    return query;
  }

  private async summarizePayments(
    status?: string,
    purpose?: string,
    search?: string,
  ) {
    const rows = await this.createPaymentsQuery(status, purpose, search)
      .select('payment.status', 'status')
      .addSelect('payment.currency', 'currency')
      .addSelect('COUNT(payment.id)', 'count')
      .addSelect('COALESCE(SUM(payment.amount), 0)', 'volume')
      .groupBy('payment.status')
      .addGroupBy('payment.currency')
      .getRawMany<{
        status: string;
        currency: string;
        count: string;
        volume: string;
      }>();

    const volume = new Map<string, number>();
    let total = 0;
    let pending = 0;
    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      const count = Number(row.count ?? 0);
      total += count;
      if (row.status === PaymentStatus.SUCCEEDED) {
        succeeded += count;
        volume.set(
          row.currency,
          (volume.get(row.currency) ?? 0) + Number(row.volume ?? 0),
        );
      } else if (
        row.status === PaymentStatus.PENDING ||
        row.status === PaymentStatus.INITIATED
      ) {
        pending += count;
      } else if (
        row.status === PaymentStatus.FAILED ||
        row.status === PaymentStatus.CANCELLED
      ) {
        failed += count;
      }
    }

    return {
      total,
      pending,
      succeeded,
      failed,
      succeededVolume: Array.from(volume, ([currency, amount]) => ({
        currency,
        amount,
      })),
    };
  }

  private adminUserSelect(alias: string): string[] {
    return [
      `${alias}.id`,
      `${alias}.firstName`,
      `${alias}.lastName`,
      `${alias}.phone`,
      `${alias}.email`,
      `${alias}.role`,
      `${alias}.status`,
      `${alias}.isDriver`,
      `${alias}.isActive`,
    ];
  }

  private serializeAdminPayment(payment: PaymentWithUser) {
    const sanitized = this.sanitizePayment(payment)!;
    return {
      ...sanitized,
      id: sanitized.id,
      user: this.sanitizeUser(payment.user),
    };
  }

  private sanitizeKycDocument(kycDocument: KycDocument) {
    return {
      ...kycDocument,
      user: this.sanitizeUser(kycDocument.user),
    };
  }

  private async serializeUsersWithDriverQualification(users: User[]) {
    const qualifications = await this.loadDriverQualifications(users);
    return users.map((user) => ({
      ...this.sanitizeUser(user)!,
      ...qualifications.get(user.id),
    }));
  }

  private async loadDriverQualifications(
    users: Array<Pick<User, 'id' | 'role' | 'isDriver'>>,
  ): Promise<Map<string, DriverQualification>> {
    const qualifications = new Map<string, DriverQualification>();
    const userIds = [
      ...new Set(users.map((user) => user.id).filter(Boolean)),
    ];

    for (const user of users) {
      qualifications.set(
        user.id,
        resolveDriverQualification({
          role: user.role,
          isDriver: user.isDriver,
          hasApprovedKyc: false,
          hasActiveVehicle: false,
        }),
      );
    }

    if (userIds.length === 0) {
      return qualifications;
    }

    const [approvedKycs, activeVehicles] = await Promise.all([
      this.kycDocumentRepository.find({
        where: { userId: In(userIds), status: KycStatus.APPROVED },
        select: ['id', 'userId'],
      }),
      this.userRepository.manager.find(Vehicle, {
        where: { ownerId: In(userIds), isActive: true },
        select: ['id', 'ownerId'],
      }),
    ]);

    const approvedKycUserIds = new Set(
      approvedKycs
        .map((document) => document.userId)
        .filter((userId): userId is string => Boolean(userId)),
    );
    const activeVehicleOwnerIds = new Set(
      activeVehicles.map((vehicle) => vehicle.ownerId),
    );

    for (const user of users) {
      qualifications.set(
        user.id,
        resolveDriverQualification({
          role: user.role,
          isDriver: user.isDriver,
          hasApprovedKyc: approvedKycUserIds.has(user.id),
          hasActiveVehicle: activeVehicleOwnerIds.has(user.id),
        }),
      );
    }

    return qualifications;
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
      throw new BadRequestException("Type d'écriture de portefeuille invalide");
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

  private normalizePaymentStatus(status?: string) {
    if (!status || status === 'all') {
      return undefined;
    }
    return Object.values(PaymentStatus).includes(status as PaymentStatus)
      ? (status as PaymentStatus)
      : undefined;
  }

  private normalizePaymentPurpose(purpose?: string) {
    if (!purpose || purpose === 'all') {
      return undefined;
    }
    return Object.values(PaymentPurpose).includes(purpose as PaymentPurpose)
      ? purpose
      : purpose.trim() || undefined;
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

  private serializeAdminAccount(user: User) {
    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      status: user.status,
      isActive: user.isActive,
      isPhoneVerified: user.isPhoneVerified,
      passwordChangeRequired: user.passwordChangeRequired,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
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
