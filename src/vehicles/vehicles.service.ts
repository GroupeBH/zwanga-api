import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vehicle } from './entities/vehicle.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class VehiclesService {
  constructor(
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async create(ownerId: string, vehicleData: Partial<Vehicle>): Promise<Vehicle> {
    const owner = await this.userRepository.findOne({ where: { id: ownerId } });
    if (!owner) {
      throw new Error('Owner not found');
    }

    const vehicle = this.vehicleRepository.create({
      ...vehicleData,
      ownerId,
    });

    return await this.vehicleRepository.save(vehicle);
  }

  async findAllByOwner(ownerId: string): Promise<Vehicle[]> {
    return this.vehicleRepository.find({
      where: { ownerId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string, ownerId: string): Promise<Vehicle> {
    const vehicle = await this.vehicleRepository.findOne({
      where: { id, ownerId },
    });

    if (!vehicle) {
      throw new Error('Vehicle not found');
    }

    return vehicle;
  }

  async update(id: string, ownerId: string, updateData: Partial<Vehicle>): Promise<Vehicle> {
    const vehicle = await this.findOne(id, ownerId);
    Object.assign(vehicle, updateData);
    return await this.vehicleRepository.save(vehicle);
  }

  async remove(id: string, ownerId: string): Promise<void> {
    const vehicle = await this.findOne(id, ownerId);
    await this.vehicleRepository.remove(vehicle);
  }
}

