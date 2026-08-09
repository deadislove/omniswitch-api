import { Money } from './money.vo';

/**
 * Spend Policy Value Object
 * The business policy a human principal attaches to a Delegation (see
 * delegation.aggregate.ts) — "up to $X per transaction, $Y per month,
 * only for [categories]" — the thing DEV_README.md's agentic-payments
 * section flagged as missing: `RolesGuard` only answers "can this
 * identity call this endpoint," not "should this specific charge be
 * allowed given everything this agent has already spent this month."
 *
 * Both limits are expressed in a single currency (the delegation's own
 * spend-policy currency) — a charge in any other currency is rejected
 * outright by DelegationService.reserveSpendOrThrow() rather than this
 * value object attempting a conversion, for the same reason
 * `Subscription.changePlan()` refuses a cross-currency plan switch
 * instead of picking an FX rate on the caller's behalf.
 */
export class SpendPolicy {
  private constructor(
    private readonly _perTransactionLimit: Money,
    private readonly _monthlyLimit: Money,
    private readonly _allowedCategories: string[] | undefined,
  ) {}

  static create(params: {
    perTransactionLimit: Money;
    monthlyLimit: Money;
    allowedCategories?: string[];
  }): SpendPolicy {
    if (params.perTransactionLimit.currency.code !== params.monthlyLimit.currency.code) {
      throw new Error(
        `perTransactionLimit (${params.perTransactionLimit.currency.code}) and monthlyLimit (${params.monthlyLimit.currency.code}) must be in the same currency`,
      );
    }
    if (params.perTransactionLimit.isGreaterThan(params.monthlyLimit)) {
      throw new Error('perTransactionLimit cannot exceed monthlyLimit');
    }
    return new SpendPolicy(
      params.perTransactionLimit,
      params.monthlyLimit,
      params.allowedCategories && params.allowedCategories.length > 0 ? params.allowedCategories : undefined,
    );
  }

  get perTransactionLimit(): Money { return this._perTransactionLimit; }
  get monthlyLimit(): Money { return this._monthlyLimit; }
  /** undefined means "no category restriction" — every category (including none supplied) is allowed. */
  get allowedCategories(): string[] | undefined { return this._allowedCategories; }
  get currency(): string { return this._perTransactionLimit.currency.code; }

  isCategoryAllowed(category: string | undefined): boolean {
    if (!this._allowedCategories) return true;
    return !!category && this._allowedCategories.includes(category);
  }
}
