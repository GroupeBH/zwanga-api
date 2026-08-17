import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum VehicleType {
  CAR = 'car',
  MOTORCYCLE_TWO_WHEELS = 'motorcycle_2_wheels',
  MOTORCYCLE_THREE_WHEELS = 'motorcycle_3_wheels',
}

export const VEHICLE_MAX_SEATS: Record<VehicleType, number | null> = {
  [VehicleType.CAR]: null,
  [VehicleType.MOTORCYCLE_TWO_WHEELS]: 2,
  [VehicleType.MOTORCYCLE_THREE_WHEELS]: 3,
};

export function getVehicleMaxSeats(
  vehicleType?: VehicleType | null,
): number | null {
  return vehicleType ? VEHICLE_MAX_SEATS[vehicleType] : null;
}

@Entity('vehicles')
export class Vehicle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  ownerId: string;

  @ManyToOne(() => User, (user) => user.vehicles)
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @Column()
  brand: string;

  @Column()
  model: string;

  @Column()
  color: string;

  @Column({
    type: 'enum',
    enum: VehicleType,
    enumName: 'vehicles_type_enum',
    default: VehicleType.CAR,
  })
  type: VehicleType;

  @Column({ unique: true })
  licensePlate: string;

  @Column({ nullable: true })
  photoUrl: string;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
