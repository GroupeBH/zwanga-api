import { BadRequestException } from '@nestjs/common';

export function schedule(
  total: bigint,
  count: number,
  period: 'week' | 'month',
  origin: Date,
) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 120 ||
    BigInt(count) > total / 10n
  )
    throw new BadRequestException('Échéancier invalide.');
  const ordinary = (total / BigInt(count) / 10n) * 10n;
  return Array.from({ length: count }, (_, index) => {
    const due = new Date(origin);
    if (period === 'week') due.setUTCDate(due.getUTCDate() + 7 * (index + 1));
    else {
      const day = due.getUTCDate();
      due.setUTCDate(1);
      due.setUTCMonth(due.getUTCMonth() + index + 1);
      due.setUTCDate(
        Math.min(
          day,
          new Date(
            Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0),
          ).getUTCDate(),
        ),
      );
    }
    return {
      ordinal: index + 1,
      dueAt: due.toISOString(),
      amountMinor: (index === count - 1
        ? total - ordinary * BigInt(index)
        : ordinary
      ).toString(),
    };
  });
}
