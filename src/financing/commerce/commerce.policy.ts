import { BadRequestException, ConflictException } from '@nestjs/common';
import { minor, floorWallet, MAX_MINOR } from '../shared/money';
import { schedule } from '../schedules/installment-schedule.policy';
import { createHash } from 'node:crypto';

export const COMMERCE_VERSION = 'commerce-v1';
export interface CommercePlan {
  id: string;
  period: 'week' | 'month';
  count: number;
}
export interface CommerceTerms {
  version: typeof COMMERCE_VERSION;
  acquisitionMinor: string;
  expensesMinor: string;
  marginMinor: string;
  minimumMarginMinor: string;
  depositMinor: string;
  plans: CommercePlan[];
}

export function publicCommerce(terms: CommerceTerms) {
  return {
    ...commercePrices(terms),
    plans: terms.plans.map((p) => ({ ...p })),
  };
}

export function purchaseQuote(
  product: { id: string; commerce: CommerceTerms; revision: number },
  mode: 'cash' | 'credit',
  planId?: string,
) {
  const prices = publicCommerce(product.commerce);
  const plan =
    mode === 'credit' ? commercePlan(product.commerce, planId ?? '') : null;
  const total =
    mode === 'cash' ? prices.cashTotalMinor : prices.creditTotalMinor;
  const deposit = mode === 'cash' ? '0' : prices.depositMinor;
  const principal = (minor(total) - minor(deposit)).toString();
  const installments = plan?.count ?? 1;
  const period = plan?.period ?? 'month';
  // Relative schedule: actual dates are set at activation, never frozen by a GET preview.
  const amounts = schedule(
    minor(principal),
    installments,
    period,
    new Date('2026-01-01T12:00:00Z'),
  ).map((i) => i.amountMinor);
  const quote = {
    ...prices,
    productId: product.id,
    revision: product.revision,
    mode,
    planId: plan?.id ?? null,
    totalMinor: total,
    depositMinor: deposit,
    principalMinor: principal,
    installments,
    period,
    installmentAmountsMinor: amounts,
    beforeDeliveryMinor:
      mode === 'cash' ? total : deposit !== '0' ? deposit : amounts[0],
  };
  return {
    ...quote,
    quoteHash: createHash('sha256').update(JSON.stringify(quote)).digest('hex'),
  };
}
export type PurchaseQuote = ReturnType<typeof purchaseQuote>;

/** All values are integer CDF cents, aligned to the existing wallet's 10-cent precision. */
export function commercePrices(terms: CommerceTerms) {
  if (terms.version !== COMMERCE_VERSION)
    throw new BadRequestException('Version commerciale inconnue.');
  const cost =
    minor(terms.acquisitionMinor, false) + minor(terms.expensesMinor);
  const total = cost + minor(terms.marginMinor);
  if (total > MAX_MINOR)
    throw new BadRequestException('Montant total trop élevé.');
  const cash = floorWallet((total * 8000n) / 10000n);
  if (cash < cost + minor(terms.minimumMarginMinor))
    throw new BadRequestException(
      'Le prix comptant à 80 % ne couvre pas les coûts et la marge minimale.',
    );
  const deposit = minor(terms.depositMinor);
  if (deposit >= total)
    throw new BadRequestException('Acompte incompatible avec le prix.');
  if (
    !Array.isArray(terms.plans) ||
    !terms.plans.length ||
    terms.plans.length > 12
  )
    throw new BadRequestException('Indiquez de une à douze formules.');
  const ids = new Set<string>();
  for (const plan of terms.plans) {
    if (
      !/^[a-z0-9-]{1,40}$/.test(plan.id) ||
      ids.has(plan.id) ||
      !['week', 'month'].includes(plan.period)
    )
      throw new BadRequestException('Formule invalide ou dupliquée.');
    ids.add(plan.id);
    schedule(
      total - deposit,
      plan.count,
      plan.period,
      new Date('2026-01-01T12:00:00Z'),
    );
  }
  return {
    creditTotalMinor: total.toString(),
    cashTotalMinor: cash.toString(),
    cashSavingMinor: (total - cash).toString(),
    depositMinor: deposit.toString(),
    cashDiscountBps: 2000,
    earlySettlementDiscountBps: 1000,
    version: COMMERCE_VERSION,
  };
}

export function commercePlan(terms: CommerceTerms, id: string) {
  commercePrices(terms);
  const plan = terms.plans.find((p) => p.id === id);
  if (!plan)
    throw new ConflictException(
      'Cette formule n’est plus disponible. Actualisez le produit.',
    );
  return plan;
}

/** Only a full, timely settlement earns the reduction; never reward an ordinary daily payment. */
export function earlySettlement(
  input: {
    remainingMinor: string;
    period: 'week' | 'month';
    finalDueAt: string;
    hasOverdue: boolean;
    mode: 'cash' | 'credit';
    version: string;
  },
  now: Date,
) {
  const remaining = minor(input.remainingMinor, false);
  const cutoff = new Date(input.finalDueAt);
  if (input.period === 'week') cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  else {
    const day = cutoff.getUTCDate();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
    cutoff.setUTCDate(
      Math.min(
        day,
        new Date(
          Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
        ).getUTCDate(),
      ),
    );
  }
  if (
    input.version !== COMMERCE_VERSION ||
    input.mode !== 'credit' ||
    input.hasOverdue ||
    !Number.isFinite(cutoff.getTime()) ||
    now > cutoff
  )
    throw new ConflictException(
      'Ce crédit ne bénéficie pas de la remise anticipée à cette date.',
    );
  const discount = floorWallet((remaining * 1000n) / 10000n);
  return {
    remainingMinor: remaining.toString(),
    discountMinor: discount.toString(),
    amountMinor: (remaining - discount).toString(),
    validUntil: cutoff.toISOString(),
  };
}
