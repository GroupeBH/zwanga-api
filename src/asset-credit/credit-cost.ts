import { BadRequestException } from '@nestjs/common';

export const CREDIT_COST_VERSION = 'asset-credit-cost-v1';
export interface CreditCostFields {
  cashPriceMinor?: number | null;
  creditFeeMinor?: number | null;
  installmentCount?: number | null;
  installmentPeriod?: 'week' | 'month' | null;
}

/** Optional only for older issuing clients. New terms are always disclosed together. */
export function validateCreditCost(total: number, fields: CreditCostFields) {
  if (Object.values(fields).every(value => value === undefined)) return null;
  const { cashPriceMinor: price, creditFeeMinor: fee, installmentCount: count, installmentPeriod: period } = fields;
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(fee) || price! < 100 || fee! < 0
    || price! % 10 !== 0 || fee! % 10 !== 0 || price! + fee! !== total)
    throw new BadRequestException('Le total doit être le prix du bien plus les frais de crédit, avec au plus une décimale en FC.');
  if (count !== undefined || period !== undefined) {
    if (!Number.isInteger(count) || count! < 1 || count! > 120 || count! > total / 10 || !['week', 'month'].includes(period!))
      throw new BadRequestException('Précisez de 1 à 120 échéances et leur périodicité (semaine ou mois).');
  }
  return CREDIT_COST_VERSION;
}

export interface ScheduleCredit {
  costDisclosureVersion?: string | null;
  principalMinor: string | number;
  paidMinor: string | number;
  installmentCount?: number | null;
  installmentPeriod?: 'week' | 'month' | null;
  activatedAt?: Date | string | null;
}

function dueDate(origin: Date, ordinal: number, period: 'week' | 'month') {
  const date = new Date(origin);
  if (period === 'week') date.setUTCDate(date.getUTCDate() + ordinal * 7);
  else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + ordinal);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
  }
  return date.toISOString();
}

/** Read-only allocation of all actual repayments, earliest minimums first. No second debt. */
export function creditSchedule(credit: ScheduleCredit, now = new Date()) {
  if (credit.costDisclosureVersion !== CREDIT_COST_VERSION || !credit.installmentCount || !credit.installmentPeriod)
    return { installments: [], minimumDueMinor: 0 };
  const total = Number(credit.principalMinor), paid = Number(credit.paidMinor), count = credit.installmentCount;
  const ordinary = Math.floor(total / 10 / count) * 10;
  const origin = credit.activatedAt ? new Date(credit.activatedAt) : null;
  let cumulative = 0, minimumDueMinor = 0;
  const installments = Array.from({ length: count }, (_, index) => {
    const amountMinor = index === count - 1 ? total - cumulative : ordinary;
    cumulative += amountMinor;
    const remainingMinor = Math.min(amountMinor, Math.max(0, cumulative - paid));
    const dueAt = origin ? dueDate(origin, index + 1, credit.installmentPeriod!) : null;
    if (dueAt && new Date(dueAt) <= now) minimumDueMinor += remainingMinor;
    return { ordinal: index + 1, dueAt, amountMinor, remainingMinor };
  });
  return { installments, minimumDueMinor };
}
