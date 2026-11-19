import { BadRequestException, ConflictException } from '@nestjs/common';
import { creditSchedule } from './credit-cost';

export type RepaymentPlan = { id: string; months: number };
export function validateRepaymentPlans(plans: RepaymentPlan[] | undefined, dto: { cashPriceMinor?: number; creditFeeMinor?: number; installmentCount?: number; installmentPeriod?: string; principalMinor: number }) {
  if (plans == null || (Array.isArray(plans) && plans.length === 0)) return [];
  if (!Array.isArray(plans) || plans.length > 6 || new Set(plans.map(p => p?.id)).size !== plans.length
    || plans.some(p => !p || !/^[a-z0-9-]{1,32}$/.test(p.id) || !Number.isInteger(p.months) || p.months < 1 || p.months > 120 || p.months > dto.principalMinor / 10)
    || dto.cashPriceMinor == null || dto.creditFeeMinor == null || dto.installmentPeriod !== 'month'
    || !plans.some(p => p.months === dto.installmentCount))
    throw new BadRequestException('Définissez jusqu’à six formules mensuelles, avec les frais et la durée par défaut.');
  return plans;
}
export function selectRepaymentPlan(credit: { repaymentPlans?: RepaymentPlan[]; selectedPlanId?: string | null; installmentCount?: number | null }, id?: string) {
  if (!credit.repaymentPlans?.length) {
    if (id) throw new ConflictException('Cette offre ne propose pas cette formule.');
    return null;
  }
  const plan = credit.repaymentPlans.find(p => p.id === id);
  if (!plan) throw new ConflictException('Choisissez une formule parmi celles du contrat.');
  if (credit.selectedPlanId && credit.selectedPlanId !== plan.id) throw new ConflictException('Une autre formule a déjà été acceptée.');
  return plan;
}
export function repaymentPlanPreviews(credit: Parameters<typeof creditSchedule>[0] & { repaymentPlans?: RepaymentPlan[] }) {
  return (credit.repaymentPlans ?? []).map(plan => ({ ...plan, ...creditSchedule({ ...credit, installmentCount: plan.months, installmentPeriod: 'month', activatedAt: null }) }));
}
