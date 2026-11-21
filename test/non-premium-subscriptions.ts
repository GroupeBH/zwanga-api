import type {
  PremiumSubscriptionFeatures,
  SubscriptionsService,
} from '../src/subscriptions/subscriptions.service';

const nonPremiumFeatures = (): PremiumSubscriptionFeatures => ({
  isActive: false,
  isPremium: false,
  premiumBadgeEnabled: false,
  featuredTripsEnabled: false,
  documentFundingEnabled: false,
  documentFundingLimit: null,
  documentFundingCurrency: 'CDF',
  subscriptionId: null,
  plan: null,
  endDate: null,
});

/** Subscription adapter for integration fixtures with no premium users. */
export function nonPremiumSubscriptions() {
  return {
    getPremiumOverview: jest.fn(() => Promise.resolve(nonPremiumFeatures())),
    getPremiumFeaturesForUsers: jest.fn((userIds: string[]) =>
      Promise.resolve(
        new Map(
          [...new Set(userIds.filter(Boolean))].map((id) => [
            id,
            nonPremiumFeatures(),
          ]),
        ),
      ),
    ),
  } satisfies Pick<
    SubscriptionsService,
    'getPremiumOverview' | 'getPremiumFeaturesForUsers'
  >;
}
