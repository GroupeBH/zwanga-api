export type DispatchDecision = 'accept' | 'decline';

export function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function dispatchOfferIsActionable(
  status: string, expiresAt: Date | string, requestStatus: string, now = Date.now(),
) {
  return status === 'pending' && new Date(expiresAt).getTime() > now &&
    (requestStatus === 'pending' || requestStatus === 'offers_received');
}
