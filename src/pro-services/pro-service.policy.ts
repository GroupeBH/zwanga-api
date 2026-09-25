import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ProServiceCase, ProServiceLedger } from './pro-service.entities';
import type { CaseState, ServiceQuote } from './pro-service.types';
import type { QuoteServiceDto, ServiceLedgerDto } from './pro-service.dto';

export function validateQuote(dto: QuoteServiceDto, now = Date.now()) {
  const principal = dto.totalMinor - dto.depositMinor;
  const dates = dto.installments.map((item) => Date.parse(item.dueDate));
  if (
    !Number.isFinite(Date.parse(dto.validUntil)) ||
    principal < 0 ||
    Date.parse(dto.validUntil) <= now ||
    dto.installments.reduce((sum, item) => sum + item.amountMinor, 0) !==
      principal ||
    dates.some(
      (date, index) =>
        !Number.isFinite(date) ||
        date <= Date.parse(dto.validUntil) ||
        (index > 0 && date <= dates[index - 1]),
    ) ||
    new Set(dto.retainedDocuments.map((doc) => doc.code)).size !==
      dto.retainedDocuments.length ||
    (principal === 0 && dto.retainedDocuments.length > 0)
  ) {
    throw new BadRequestException(
      'Devis incohérent : vérifiez apport, échéances, validité et originaux.',
    );
  }
}
export function financialSummary(
  quote: ServiceQuote | null,
  entries: Pick<ProServiceLedger, 'kind' | 'amountMinor'>[],
) {
  const total = (kind: string) =>
    entries
      .filter((entry) => entry.kind === kind)
      .reduce((sum, entry) => sum + entry.amountMinor, 0);
  const fundedMinor = total('funding'),
    repaidMinor = total('repayment'),
    depositPaidMinor = total('deposit');
  const balanceMinor = Math.max(0, fundedMinor - repaidMinor);
  let remainingRepaid = repaidMinor;
  const installments = (quote?.installments ?? []).map((item) => {
    const paidMinor = Math.min(remainingRepaid, item.amountMinor);
    remainingRepaid -= paidMinor;
    return { ...item, paidMinor, remainingMinor: item.amountMinor - paidMinor };
  });
  return {
    currency: quote?.currency ?? null,
    fundedMinor,
    repaidMinor,
    depositPaidMinor,
    balanceMinor,
    settled: fundedMinor > 0 && balanceMinor === 0,
    installments,
  };
}
export function validateLedger(
  quote: ServiceQuote,
  entries: ProServiceLedger[],
  dto: ServiceLedgerDto,
) {
  const totals = financialSummary(quote, entries),
    principal = quote.totalMinor - quote.depositMinor;
  if (
    dto.kind === 'deposit' &&
    (totals.fundedMinor > 0 ||
      totals.depositPaidMinor + dto.amountMinor > quote.depositMinor)
  ) {
    throw new BadRequestException(
      'Cet apport dépasse le montant accepté ou a déjà été réglé.',
    );
  }
  if (
    dto.kind === 'funding' &&
    (totals.fundedMinor > 0 ||
      dto.amountMinor !== principal ||
      totals.depositPaidMinor !== quote.depositMinor)
  ) {
    throw new BadRequestException(
      'Confirmez l’apport puis une seule avance du montant exact accepté.',
    );
  }
  if (
    dto.kind === 'repayment' &&
    (!totals.fundedMinor || dto.amountMinor > totals.balanceMinor)
  ) {
    throw new BadRequestException(
      'Ce remboursement dépasse le solde dû ou aucune avance n’a été confirmée.',
    );
  }
}
const transitions: Partial<Record<CaseState, CaseState[]>> = {
  submitted: ['reviewing', 'needs_info', 'rejected', 'cancelled'],
  reviewing: ['needs_info', 'rejected', 'cancelled'],
  needs_info: ['reviewing', 'rejected', 'cancelled'],
  quoted: ['reviewing', 'rejected', 'cancelled'],
  accepted: ['processing'],
  processing: ['ready'],
  ready: ['completed'],
};
export function assertTransition(item: ProServiceCase, next: CaseState) {
  if (!transitions[item.status]?.includes(next))
    throw new ConflictException(
      'Cette transition n’est pas autorisée pour ce dossier.',
    );
}
export function assertAccepted(item: ProServiceCase) {
  if (
    !item.quote ||
    item.acceptedQuoteVersion !== item.quote.version ||
    !item.acceptedAt
  ) {
    throw new ConflictException(
      'Le titulaire doit d’abord accepter le devis et les conditions validées.',
    );
  }
}
