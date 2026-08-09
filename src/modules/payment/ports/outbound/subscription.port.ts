import { Subscription, SubscriptionStatus } from '../../domain/aggregates/subscription.aggregate';

export interface FindSubscriptionsFilter {
  merchantId?: string;
  customerId?: string;
  status?: SubscriptionStatus;
  limit?: number;
}

export abstract class SubscriptionPort {
  abstract save(subscription: Subscription): Promise<void>;
  abstract findById(id: string): Promise<Subscription | null>;
  abstract findMany(filter?: FindSubscriptionsFilter): Promise<Subscription[]>;

  /** Everything the billing sweep needs to consider — not paginated, unlike findMany(). */
  abstract findDue(now: Date): Promise<Subscription[]>;
}
