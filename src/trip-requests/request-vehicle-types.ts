import { BadRequestException } from '@nestjs/common';
import { In } from 'typeorm';
import { VehicleType } from '../vehicles/entities/vehicle.entity';

export interface RequestVehicleSelection {
  vehicleType?: VehicleType | null;
  vehicleTypes?: VehicleType[] | null;
}

/** Old requests and old clients keep their single explicit vehicle choice. */
export function requestVehicleTypes(request: RequestVehicleSelection): VehicleType[] {
  return request.vehicleTypes?.length
    ? [...request.vehicleTypes]
    : [request.vehicleType ?? VehicleType.CAR];
}

export function resolveRequestVehicleTypes(input: RequestVehicleSelection, previous?: RequestVehicleSelection): VehicleType[] {
  if (input.vehicleTypes !== undefined) {
    const types = input.vehicleTypes;
    if (!Array.isArray(types) || types.length < 1 || types.length > 3 ||
        new Set(types).size !== types.length || types.some(type => !Object.values(VehicleType).includes(type))) {
      throw new BadRequestException('Choisissez un à trois types de véhicule différents et valides.');
    }
    if (input.vehicleType !== undefined && !types.includes(input.vehicleType!)) {
      throw new BadRequestException('Le type de véhicule principal doit faire partie des types choisis.');
    }
    return [...types];
  }
  if (input.vehicleType !== undefined) {
    if (!Object.values(VehicleType).includes(input.vehicleType!)) throw new BadRequestException('Type de véhicule invalide.');
    return [input.vehicleType!];
  }
  if (previous) return requestVehicleTypes(previous);
  throw new BadRequestException('Choisissez au moins un type de véhicule.');
}

export const requestAcceptsVehicle = (request: RequestVehicleSelection, type: VehicleType) =>
  requestVehicleTypes(request).includes(type);

export function requestVehicleTypeFilter(request: RequestVehicleSelection) {
  const types = requestVehicleTypes(request);
  return types.length === 1 ? types[0] : In(types);
}

/** Internal SQL alias only, never a client-supplied identifier. */
export const requestVehicleTypesSql = (alias: string) =>
  `COALESCE(${alias}."vehicleTypes", ARRAY[${alias}."vehicleType"::text])`;
