import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { CreditStore } from '../shared/credit.store';
import { CreditCatalogService } from '../catalogue/credit-catalogue.service';
import { CreditEligibilityService } from '../eligibility/credit-eligibility.service';
import {
  SubmitCreditApplicationDto,
  ReviewCreditApplicationDto,
} from './credit-applications.dto';
import type {
  ProductRow,
  PolicyRow,
  IdRow,
  ApplicationRow,
} from '../shared/credit.rows';
import { minor } from '../shared/money';
import { schedule } from '../schedules/installment-schedule.policy';
import { evaluateCredit } from '../eligibility/credit-eligibility.policy';
import type { CreditActor } from '../shared/credit.store';
import { createHash } from 'node:crypto';
import { FINANCING_CONTRACT_VERSION } from '../contracts/contract-version';
import { CreditPageDto } from '../shared/credit.dto';

@Injectable()
export class CreditApplicationsService {
  constructor(
    private readonly store: CreditStore,
    private readonly catalog: CreditCatalogService,
    private readonly eligibility: CreditEligibilityService,
  ) {}

  async apply(driverId: string, dto: SubmitCreditApplicationDto) {
    return this.store.mutation(
      driverId,
      dto.mutationId,
      'application',
      dto,
      async (m) => {
        await this.store.driverLock(m, driverId);
        const [product] = await m.query<ProductRow[]>(
          'SELECT * FROM pro_credit_products WHERE id=$1 FOR SHARE',
          [dto.productId],
        );
        if (!product) throw new NotFoundException('Produit introuvable.');
        await this.catalog.gate(m, product);
        const [policy] = await m.query<PolicyRow[]>(
          'SELECT * FROM pro_credit_policies WHERE id=$1',
          [product.policyId],
        );
        const deposit = minor(dto.depositMinor),
          price = minor(product.priceMinor, false),
          fee = minor(product.feeMinor);
        if (
          deposit >= price ||
          price - deposit < 100n ||
          dto.installments > policy.rules.maxInstallments
        )
          throw new BadRequestException(
            'Acompte ou durée incompatibles avec cette offre.',
          );
        const principal = price - deposit + fee;
        schedule(principal, dto.installments, dto.period, new Date());
        const evaluation = {
          ...evaluateCredit(
            await this.eligibility.facts(m, driverId),
            policy.rules,
            principal.toString(),
            dto.depositMinor,
            product.priceMinor,
          ),
          rulesVersion: policy.version,
        };
        if (!evaluation.eligible)
          throw new ConflictException({
            code: 'PRO_INELIGIBLE',
            ...evaluation,
          });
        if (product.kind === 'document') {
          const [vehicle] = await m.query<
            { type: ProductRow['details']['vehicleTypes'][number] }[]
          >(
            'SELECT type FROM vehicles WHERE id=$1 AND "ownerId"=$2 AND "isActive"=true FOR SHARE',
            [dto.vehicleId ?? null, driverId],
          );
          const [dossier] = await m.query<IdRow[]>(
            'SELECT id FROM pro_service_cases WHERE id=$1 AND "ownerId"=$2 AND "serviceCode"=\'documents\' FOR SHARE',
            [dto.caseId ?? null, driverId],
          );
          if (
            !vehicle ||
            !dossier ||
            (product.details.vehicleTypes.length &&
              !product.details.vehicleTypes.includes(vehicle.type))
          )
            throw new ConflictException(
              'Véhicule autorisé et dossier documentaire existant requis.',
            );
        } else if (dto.caseId || dto.vehicleId)
          throw new BadRequestException(
            'Ce produit ne finance pas un document de véhicule.',
          );
        const codes = new Set(dto.evidence.map((e) => e.code));
        if (
          codes.size !== dto.evidence.length ||
          product.details.requiredEvidence.some((code) => !codes.has(code))
        )
          throw new BadRequestException(
            'Justificatifs requis manquants ou dupliqués.',
          );
        for (const evidence of dto.evidence) {
          const [owned] = await m.query<IdRow[]>(
            'SELECT id FROM pro_credit_attachments WHERE id=$1 AND "ownerId"=$2',
            [evidence.attachmentId, driverId],
          );
          if (!owned) throw new NotFoundException('Justificatif introuvable.');
        }
        const kind = product.kind === 'phone' ? 'phone' : 'equipment';
        const [existing] = await m.query<IdRow[]>(
          'SELECT id FROM asset_credit_requests WHERE "driverId"=$1 AND "assetKind"=$2 AND status=\'submitted\'',
          [driverId, kind],
        );
        if (existing)
          throw new ConflictException({
            code: 'PRO_REQUEST_EXISTS',
            id: existing.id,
            message: 'Une demande est déjà en cours.',
          });
        const snapshot = {
          product,
          policy: {
            version: policy.version,
            terms: policy.terms,
            rules: policy.rules,
          },
          depositMinor: dto.depositMinor,
          principalMinor: principal.toString(),
          installments: dto.installments,
          period: dto.period,
        };
        const [request] = await m.query<ApplicationRow[]>(
          `INSERT INTO asset_credit_requests("driverId","assetKind",notes,"proProductId","proMutationId","proApplication")
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            driverId,
            kind,
            dto.notes.trim(),
            product.id,
            dto.mutationId,
            JSON.stringify({
              snapshot,
              evaluation,
              evidence: dto.evidence,
              vehicleId: dto.vehicleId ?? null,
              caseId: dto.caseId ?? null,
            }),
          ],
        );
        await this.store.audit(m, driverId, 'application_submitted', {
          requestId: request.id,
          evaluation,
        });
        await this.store.notify(
          m,
          driverId,
          request.id,
          `request:${request.id}`,
        );
        return request;
      },
    );
  }

  async review(
    actor: CreditActor,
    id: string,
    dto: ReviewCreditApplicationDto,
  ) {
    return this.store.mutation(
      actor.userId,
      dto.mutationId,
      'review',
      { id, ...dto },
      async (m) => {
        const [owner] = await m.query<{ driverId: string }[]>(
          'SELECT "driverId" FROM asset_credit_requests WHERE id=$1 AND "proProductId" IS NOT NULL',
          [id],
        );
        if (!owner) throw new NotFoundException('Demande introuvable.');
        await this.store.driverLock(m, owner.driverId);
        const [request] = await m.query<ApplicationRow[]>(
          'SELECT * FROM asset_credit_requests WHERE id=$1 FOR UPDATE',
          [id],
        );
        const { snapshot, vehicleId, caseId } = request.proApplication;
        await this.store.authorize(
          m,
          actor,
          ['analyst', 'funder'],
          snapshot.product.creditorId,
        );
        if (actor.userId === owner.driverId)
          throw new ConflictException('Auto-approbation interdite.');
        if (request.status !== 'submitted')
          throw new ConflictException('Demande déjà examinée.');
        if (!dto.approve) {
          await m.query(
            "UPDATE asset_credit_requests SET status='closed' WHERE id=$1",
            [id],
          );
          await this.store.audit(m, actor.userId, 'application_rejected', {
            requestId: id,
            reason: dto.reason,
          });
          await this.store.notify(m, owner.driverId, id, `rejected:${id}`);
          return { id, status: 'rejected' };
        }
        const [current] = await m.query<ProductRow[]>(
          'SELECT * FROM pro_credit_products WHERE id=$1 FOR SHARE',
          [snapshot.product.id],
        );
        await this.catalog.gate(m, current);
        const evaluation = {
          ...evaluateCredit(
            await this.eligibility.facts(m, owner.driverId),
            snapshot.policy.rules,
            snapshot.principalMinor,
            snapshot.depositMinor,
            snapshot.product.priceMinor,
          ),
          rulesVersion: snapshot.policy.version,
        };
        if (!evaluation.eligible)
          throw new ConflictException({
            code: 'PRO_INELIGIBLE',
            ...evaluation,
          });
        const termsHash = createHash('sha256')
          .update(JSON.stringify(snapshot))
          .digest('hex');
        const [credit] = await m.query<IdRow[]>(
          `INSERT INTO asset_credits("driverId","assetKind",label,"principalMinor",terms,"policyVersion","repaymentBps",
        "validationReference","createdBy","mutationId","requestPayload","cashPriceMinor","creditFeeMinor","installmentCount","installmentPeriod","costDisclosureVersion")
        VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,'asset-credit-cost-v1') RETURNING id`,
          [
            owner.driverId,
            request.assetKind,
            snapshot.product.name,
            snapshot.principalMinor,
            snapshot.policy.terms,
            FINANCING_CONTRACT_VERSION,
            dto.reason,
            actor.userId,
            dto.mutationId,
            JSON.stringify({ requestId: id }),
            (
              minor(snapshot.product.priceMinor) - minor(snapshot.depositMinor)
            ).toString(),
            snapshot.product.feeMinor,
            snapshot.installments,
            snapshot.period,
          ],
        );
        await m.query(
          `INSERT INTO pro_credit_contracts("creditId","requestId","productId","creditorId","vehicleId","caseId",snapshot,"termsHash",evaluation,"depositMinor")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            credit.id,
            id,
            snapshot.product.id,
            snapshot.product.creditorId,
            vehicleId,
            caseId,
            JSON.stringify(snapshot),
            termsHash,
            JSON.stringify(evaluation),
            snapshot.depositMinor,
          ],
        );
        await m.query(
          "UPDATE asset_credit_requests SET status='offered' WHERE id=$1",
          [id],
        );
        await this.store.audit(
          m,
          actor.userId,
          'contract_offered',
          { requestId: id, termsHash, reason: dto.reason },
          credit.id,
        );
        await this.store.notify(
          m,
          owner.driverId,
          credit.id,
          `offered:${credit.id}`,
        );
        return { id: credit.id, status: 'offered' };
      },
    );
  }

  async application(actor: CreditActor, id: string, admin = false) {
    const [r] = await this.store.db.query<ApplicationRow[]>(
      `SELECT id,"driverId",status,notes,"proApplication","createdAt" FROM asset_credit_requests
      WHERE id=$1 AND "proProductId" IS NOT NULL AND ($2::uuid IS NULL OR "driverId"=$2)`,
      [id, admin ? null : actor.userId],
    );
    if (!r) throw new NotFoundException('Demande introuvable.');
    if (admin)
      await this.store.authorize(
        this.store.db.manager,
        actor,
        ['analyst', 'auditor', 'funder'],
        r.proApplication.snapshot.product.creditorId,
      );
    return r;
  }
  async list(actor: CreditActor, page: CreditPageDto, admin = false) {
    if (admin)
      await this.store.authorize(this.store.db.manager, actor, [
        'manager',
        'analyst',
        'accountant',
        'collector',
        'auditor',
      ]);
    const rows = await this.store.db.query<ApplicationRow[]>(
      `SELECT id,"driverId","proProductId",status,notes,"createdAt" FROM asset_credit_requests
      WHERE "proProductId" IS NOT NULL AND ($1::uuid IS NULL OR "driverId"=$1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,
      [admin ? null : actor.userId, page.after ?? null, page.limit + 1],
    );
    return {
      items: rows.slice(0, page.limit),
      nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    };
  }
}
