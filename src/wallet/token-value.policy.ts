// CDF denomination is a platform-wide business invariant. Old environment
// values must not let different financial services quote different prices.
export const TOKEN_VALUE_CDF = 25;
export const REFERRAL_MIN_WITHDRAWAL_TOKENS = 1000;
export const REFERRAL_MIN_WITHDRAWAL_CDF =
  REFERRAL_MIN_WITHDRAWAL_TOKENS * TOKEN_VALUE_CDF;
