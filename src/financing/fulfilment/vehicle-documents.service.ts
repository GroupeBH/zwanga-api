import { Injectable, BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { ContractRow } from '../shared/credit.rows';
import { DeliverCreditProductDto } from './credit-delivery.dto';

@Injectable()
export class VehicleDocumentsService {
  async issue(m: EntityManager, c: ContractRow, dto: DeliverCreditProductDto) {
    const id = c.id;
    if (
      dto.stockId ||
      !dto.issuedAt ||
      new Date(dto.issuedAt) > new Date() ||
      (dto.expiresAt && new Date(dto.expiresAt) <= new Date(dto.issuedAt))
    )
      throw new BadRequestException(
        'Dates de délivrance et de validité incohérentes.',
      );
    if (c.snapshot.product.details.validityDays && !dto.expiresAt)
      throw new BadRequestException('Date d’expiration requise.');
    await m.query(
      'INSERT INTO pro_credit_documents("creditId","vehicleId","proofId","issuedAt","expiresAt") VALUES($1,$2,$3,$4,$5)',
      [id, c.vehicleId, dto.proofId, dto.issuedAt, dto.expiresAt ?? null],
    );
  }
}
