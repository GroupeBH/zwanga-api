import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { DriverEarning } from '../driver-settlements/entities/driver-earning.entity';
import { ReferralProfile } from '../referrals/entities/referral-profile.entity';
import {
  ReferralReward,
  ReferralRewardSourceType,
} from '../referrals/entities/referral-reward.entity';
import { Trip } from '../trips/entities/trip.entity';
import { User } from '../users/entities/user.entity';
import { buildTripStatement, type StatementPerson } from './trip-statement';

const person = (user?: User | null): StatementPerson | null => {
  if (!user) return null;
  return {
    id: user.id,
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    phone: user.phone ?? null,
  };
};

@Injectable()
export class TripStatementService {
  constructor(
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(ReferralProfile)
    private readonly profiles: Repository<ReferralProfile>,
    @InjectRepository(ReferralReward)
    private readonly rewards: Repository<ReferralReward>,
    @InjectRepository(DriverEarning)
    private readonly earnings: Repository<DriverEarning>,
    private readonly config: ConfigService,
  ) {}

  async getStatement(tripId: string) {
    const trip = await this.trips.findOne({
      where: { id: tripId },
      relations: ['driver', 'vehicle', 'bookings', 'bookings.passenger'],
    });
    if (!trip) {
      throw new NotFoundException('Trajet introuvable.');
    }

    const bookings = trip.bookings ?? [];
    const passengerIds = [...new Set(bookings.map((booking) => booking.passengerId))];
    const bookingIds = bookings.map((booking) => booking.id);
    const [profiles, rewards, earnings] = await Promise.all([
      passengerIds.length
        ? this.profiles.find({
            where: { userId: In(passengerIds) },
            relations: ['referredByUser'],
          })
        : [],
      bookingIds.length
        ? this.rewards.find({
            where: {
              sourceType: ReferralRewardSourceType.BOOKING_PAYMENT,
              sourceEntityId: In(bookingIds),
            },
            relations: ['referrerUser'],
          })
        : [],
      this.earnings.find({ where: { tripId } }),
    ]);

    return buildTripStatement({
      referralRate: this.config.get<string | number>('REFERRAL_BOOKING_REWARD_RATE'),
      trip: {
        id: trip.id,
        departureLocation: trip.departureLocation,
        arrivalLocation: trip.arrivalLocation,
        departureDate: trip.departureDate,
        status: trip.status,
        totalSeats: trip.totalSeats,
        availableSeats: trip.availableSeats,
        pricePerSeat: trip.pricePerSeat,
        isFree: trip.isFree,
        isPrivate: trip.isPrivate,
        description: trip.description ?? null,
        acceptedPaymentModes: trip.acceptedPaymentModes ?? [],
        createdAt: trip.createdAt,
        startedAt: trip.startedAt,
        completedAt: trip.completedAt,
        driver: person(trip.driver),
        vehicle: trip.vehicle
          ? {
              brand: trip.vehicle.brand,
              model: trip.vehicle.model,
              color: trip.vehicle.color,
              licensePlate: trip.vehicle.licensePlate,
              type: trip.vehicle.type,
            }
          : null,
      },
      bookings: bookings.map((booking: Booking) => ({
        id: booking.id,
        status: booking.status,
        paymentMode: booking.paymentMode,
        paymentStatus: booking.paymentStatus,
        numberOfSeats: booking.numberOfSeats,
        paymentAmount: booking.paymentAmount,
        grossPaymentAmount: booking.grossPaymentAmount,
        zwangaSubsidyAmount: booking.zwangaSubsidyAmount,
        cashCommissionPolicyVersion: booking.cashCommissionPolicyVersion,
        cashCommissionTokenValue: booking.cashCommissionTokenValue,
        passenger: person(booking.passenger),
      })),
      referrers: profiles.flatMap((profile) => {
        const referrer = person(profile.referredByUser);
        return referrer ? [{ passengerId: profile.userId, referrer }] : [];
      }),
      rewards: rewards.map((reward) => ({
        bookingId: reward.sourceEntityId,
        status: reward.status,
        rewardAmount: reward.rewardAmount,
        referrer: person(reward.referrerUser),
      })),
      earnings: earnings.map((earning) => ({
        bookingId: earning.bookingId,
        status: earning.status,
        grossAmount: earning.grossAmount,
        commissionAmount: earning.commissionAmount,
        netAmount: earning.netAmount,
      })),
    });
  }
}
