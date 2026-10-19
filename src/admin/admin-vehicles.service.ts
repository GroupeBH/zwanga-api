import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { isAdminRole } from '../users/user-role.policy';
import { Vehicle } from '../vehicles/entities/vehicle.entity';
import { VehiclesService } from '../vehicles/vehicles.service';
import { FileUploadService } from '../common/services/file-upload.service';
import {
  AdminUpdateVehicleDto,
  AdminVehiclesQueryDto,
} from './dto/admin-vehicles.dto';

const EDITABLE_FIELDS = [
  'brand',
  'model',
  'color',
  'type',
  'licensePlate',
  'photoUrl',
  'isActive',
] as const;
const OWNER_FIELDS = [
  'id',
  'firstName',
  'lastName',
  'phone',
  'email',
  'role',
  'status',
  'isActive',
] as const;

@Injectable()
export class AdminVehiclesService {
  private readonly logger = new Logger(AdminVehiclesService.name);

  constructor(
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly vehicleOperations: VehiclesService,
    private readonly files: FileUploadService,
  ) {}

  async list(actorId: string, filters: AdminVehiclesQueryDto) {
    await this.assertAdmin(actorId);
    const { page = 1, limit = 25, vehicleType, isActive, search } = filters;
    const query = this.vehicleQuery();
    if (vehicleType)
      query.andWhere('vehicle.type = :vehicleType', { vehicleType });
    if (isActive !== undefined)
      query.andWhere('vehicle.isActive = :isActive', {
        isActive: isActive === 'true',
      });
    const term = search?.trim().toLowerCase();
    if (term) {
      query.andWhere(
        `(LOWER(vehicle.licensePlate) LIKE :term OR LOWER(vehicle.brand) LIKE :term OR LOWER(vehicle.model) LIKE :term OR LOWER(owner.firstName) LIKE :term OR LOWER(owner.lastName) LIKE :term OR LOWER(CONCAT(owner.firstName, ' ', owner.lastName)) LIKE :term OR owner.phone LIKE :term)`,
        { term: `%${term.replace(/[\%_]/g, '\$&')}%` },
      );
    }
    const [vehicles, total] = await query
      .orderBy('vehicle.createdAt', 'DESC')
      .addOrderBy('vehicle.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      vehicles: await Promise.all(
        vehicles.map((vehicle) => this.serialize(vehicle)),
      ),
      total,
      page,
      limit,
    };
  }

  async get(actorId: string, vehicleId: string) {
    await this.assertAdmin(actorId);
    return this.serialize(await this.findVehicle(vehicleId));
  }

  async update(actorId: string, vehicleId: string, dto: AdminUpdateVehicleDto) {
    await this.assertAdmin(actorId);
    const patch = Object.fromEntries(
      EDITABLE_FIELDS.filter((key) => dto[key] !== undefined).map((key) => [
        key,
        dto[key],
      ]),
    ) as Partial<Vehicle>;
    if (!Object.keys(patch).length)
      throw new BadRequestException(
        'Indiquez au moins un champ du véhicule à modifier.',
      );
    const vehicle = await this.findVehicle(vehicleId);
    // Resolve ownership from the database, never from the admin's payload.
    // Reuse plate normalization/uniqueness, type capacity, deactivation checks,
    // driver eligibility and cache invalidation from the existing vehicle flow.
    const updated = await this.vehicleOperations.update(
      vehicleId,
      vehicle.ownerId,
      patch,
    );
    this.logger.log(
      `Admin ${actorId} updated vehicle ${vehicleId}; fields=${Object.keys(patch).join(',')}`,
    );
    return this.serialize({ ...updated, owner: vehicle.owner });
  }

  async deactivate(actorId: string, vehicleId: string) {
    await this.assertAdmin(actorId);
    const vehicle = await this.findVehicle(vehicleId);
    await this.vehicleOperations.remove(vehicleId, vehicle.ownerId);
    this.logger.log(`Admin ${actorId} deactivated vehicle ${vehicleId}`);
    return {
      id: vehicleId,
      isActive: false,
      message: 'Véhicule désactivé avec succès.',
    };
  }

  private vehicleQuery() {
    // Many-to-one owner join; bounded fields, no per-vehicle database lookup.
    return this.vehicles
      .createQueryBuilder('vehicle')
      .leftJoin('vehicle.owner', 'owner')
      .addSelect(OWNER_FIELDS.map((field) => `owner.${field}`));
  }

  private async findVehicle(id: string) {
    const vehicle = await this.vehicleQuery()
      .where('vehicle.id = :id', { id })
      .getOne();
    if (!vehicle) throw new NotFoundException('Véhicule introuvable.');
    return vehicle;
  }

  private async assertAdmin(id: string) {
    const actor = await this.users.findOne({
      where: { id },
      select: ['id', 'role', 'isActive', 'status', 'passwordChangeRequired'],
    });
    if (
      !actor ||
      !isAdminRole(actor.role) ||
      !actor.isActive ||
      actor.passwordChangeRequired ||
      actor.status === UserStatus.SUSPENDED ||
      actor.status === UserStatus.INACTIVE
    ) {
      throw new ForbiddenException(
        'Action réservée à un administrateur actif.',
      );
    }
  }

  private async serialize(vehicle: Vehicle) {
    const owner = vehicle.owner;
    return {
      id: vehicle.id,
      ownerId: vehicle.ownerId,
      brand: vehicle.brand,
      model: vehicle.model,
      color: vehicle.color,
      type: vehicle.type,
      licensePlate: vehicle.licensePlate,
      photoUrl: await this.files.getPresignedUrlIfS3Key(
        vehicle.photoUrl ?? null,
      ),
      isActive: vehicle.isActive,
      createdAt: vehicle.createdAt,
      updatedAt: vehicle.updatedAt,
      owner: owner
        ? {
            id: owner.id,
            firstName: owner.firstName,
            lastName: owner.lastName,
            phone: owner.phone,
            email: owner.email,
            role: owner.role,
            status: owner.status,
            isActive: owner.isActive,
          }
        : null,
    };
  }
}
