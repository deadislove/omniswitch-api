import { Money } from '../value-objects/money.vo';

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
export type BillingInterval = 'day' | 'week' | 'month' | 'year';

/**
 * Advances a date by a billing interval. Uses UTC accessors throughout —
 * see docs/technical/reconciliation.md's note on raw Date objects silently
 * shifting by the host machine's local offset; a billing schedule is
 * exactly the kind of thing that bug class would quietly corrupt.
 *
 * Known simplification: 'month'/'year' use JS's native
 * setUTCMonth()/setUTCFullYear(), which overflows on a day that doesn't
 * exist in the target month (Jan 31 + 1 month becomes Mar 3, not Feb 28).
 * Real billing systems (Stripe included) clamp to the target month's last
 * day instead — not implemented here; a subscription anchored on the 29th
 * through 31st will drift forward across February in the current
 * implementation. Documented, not fixed.
 */
export function addBillingInterval(date: Date, interval: BillingInterval, count: number): Date {
  const d = new Date(date.getTime());
  switch (interval) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + count);
      break;
    case 'week':
      d.setUTCDate(d.getUTCDate() + count * 7);
      break;
    case 'month':
      d.setUTCMonth(d.getUTCMonth() + count);
      break;
    case 'year':
      d.setUTCFullYear(d.getUTCFullYear() + count);
      break;
  }
  return d;
}

/**
 * Days to wait before each successive dunning retry after a failed
 * charge — index 0 applies after the 1st failure (before the 2nd
 * attempt), index 1 after the 2nd (before the 3rd), index 2 after the
 * 3rd (before the 4th and final attempt). A fixed backoff schedule
 * spread over about a week, not the "retry on the very next daily sweep
 * tick" behavior this used to have — see recordFailedCharge()'s
 * docblock for why that was a real gap, not just a stylistic choice.
 */
const RETRY_SCHEDULE_DAYS = [1, 3, 7];

/**
 * Decline codes a real card network/PSP can return where retrying is
 * actively harmful, not just unlikely to succeed — a stolen/lost/
 * fraudulent card retried again is a real signal to whoever's monitoring
 * for card testing, and an expired card will never succeed on a retry
 * with the *same* stored credential regardless of backoff. A
 * subscription that gets one of these skips the day 1/3/7 retry schedule
 * entirely and cancels immediately, however few attempts it's made so
 * far — unlike `insufficient_funds` (worth retrying — the card might
 * work again in a few days) or an unrecognized/absent code (a routing
 * failure that never reached a PSP, or a code this list doesn't know
 * about), which both still get the full retry schedule. See
 * `docs/business-domain/subscriptions.md`'s Dunning section for the
 * fuller reasoning and this list's known limitation (it's a fixed,
 * illustrative set, not derived from real chargeback/decline data —
 * same posture as `RiskTieringService`'s tiers or the dispute
 * auto-decision reason-code table).
 */
const HARD_DECLINE_CODES = new Set([
  'stolen_card', 'lost_card', 'fraudulent', 'pickup_card', 'restricted_card', 'expired_card',
]);

export type DeclineCategory = 'RETRYABLE' | 'HARD_DECLINE';

export function classifyDeclineCode(errorCode: string | undefined): DeclineCategory {
  return errorCode && HARD_DECLINE_CODES.has(errorCode) ? 'HARD_DECLINE' : 'RETRYABLE';
}

/**
 * Subscription Aggregate
 * Produces charges over time — genuinely distinct from PaymentAggregate,
 * which models a single charge. Each successful billing cycle creates its
 * own PaymentAggregate (see SubscriptionService.runBillingSweep()); this
 * aggregate only tracks the schedule and its own lifecycle
 * (TRIALING -> ACTIVE <-> PAST_DUE -> CANCELED).
 *
 * A subscription can optionally be created from a `Plan` (a reusable
 * catalog entry — see plan.aggregate.ts), but always carries its own
 * amount/currency/interval directly rather than a live reference to one —
 * `planId` is provenance ("this was created from/last changed to Plan
 * X"), not something re-read from the Plan on every billing cycle. That
 * snapshotting is deliberate: a Plan's price is meant to be immutable
 * once created (see Plan's own docblock), so there's no "the plan changed
 * out from under an existing subscriber" case to handle — but even if a
 * Plan were ever edited, a subscription shouldn't silently start being
 * billed a different amount without an explicit plan-change action
 * (`SubscriptionService.changePlan()`) going through proration.
 */
export class Subscription {
  private constructor(
    private readonly _id: string,
    private readonly _merchantId: string,
    private readonly _customerId: string,
    private _amount: Money,
    private _interval: BillingInterval,
    private _intervalCount: number,
    private readonly _paymentMethodId: string,
    private _status: SubscriptionStatus,
    private _currentPeriodStart: Date,
    private _currentPeriodEnd: Date,
    private _cancelAtPeriodEnd: boolean,
    private _failedAttempts: number,
    private readonly _orderId: string | undefined,
    private readonly _description: string | undefined,
    private _canceledAt: Date | undefined,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
    private _planId: string | undefined,
    private _pendingCredit: Money | undefined,
    private _nextRetryAt: Date | undefined,
    private _lastDeclineCode: string | undefined,
  ) {}

  /** No charge yet — the first real charge happens when the trial period elapses (see runBillingSweep()'s TRIALING branch), not at creation. */
  static startTrial(params: {
    id: string;
    merchantId: string;
    customerId: string;
    amount: Money;
    interval: BillingInterval;
    intervalCount: number;
    paymentMethodId: string;
    trialDays: number;
    orderId?: string;
    description?: string;
    planId?: string;
  }): Subscription {
    const now = new Date();
    const currentPeriodEnd = new Date(now.getTime() + params.trialDays * 24 * 60 * 60 * 1000);
    return new Subscription(
      params.id, params.merchantId, params.customerId, params.amount,
      params.interval, params.intervalCount, params.paymentMethodId,
      'TRIALING', now, currentPeriodEnd, false, 0,
      params.orderId, params.description, undefined, now, now, params.planId,
      undefined, undefined, undefined,
    );
  }

  /** Only called by SubscriptionService after the first charge has already succeeded — see that service's createSubscription(). */
  static startActive(params: {
    id: string;
    merchantId: string;
    customerId: string;
    amount: Money;
    interval: BillingInterval;
    intervalCount: number;
    paymentMethodId: string;
    orderId?: string;
    description?: string;
    planId?: string;
  }): Subscription {
    const now = new Date();
    const currentPeriodEnd = addBillingInterval(now, params.interval, params.intervalCount);
    return new Subscription(
      params.id, params.merchantId, params.customerId, params.amount,
      params.interval, params.intervalCount, params.paymentMethodId,
      'ACTIVE', now, currentPeriodEnd, false, 0,
      params.orderId, params.description, undefined, now, now, params.planId,
      undefined, undefined, undefined,
    );
  }

  static reconstitute(params: {
    id: string;
    merchantId: string;
    customerId: string;
    amount: Money;
    interval: BillingInterval;
    intervalCount: number;
    paymentMethodId: string;
    status: SubscriptionStatus;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    failedAttempts: number;
    orderId?: string;
    description?: string;
    canceledAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    planId?: string;
    pendingCredit?: Money;
    nextRetryAt?: Date;
    lastDeclineCode?: string;
  }): Subscription {
    return new Subscription(
      params.id, params.merchantId, params.customerId, params.amount,
      params.interval, params.intervalCount, params.paymentMethodId,
      params.status, params.currentPeriodStart, params.currentPeriodEnd,
      params.cancelAtPeriodEnd, params.failedAttempts, params.orderId,
      params.description, params.canceledAt, params.createdAt, params.updatedAt,
      params.planId, params.pendingCredit, params.nextRetryAt, params.lastDeclineCode,
    );
  }

  /**
   * What the billing sweep should do with this subscription right now —
   * a pure decision, no side effects. `cancelAtPeriodEnd` is checked
   * *before* charging: a subscription due for period-end cancellation
   * should never attempt one more charge just to immediately cancel.
   *
   * A `PAST_DUE` subscription with a future `nextRetryAt` returns `NONE`
   * even though `currentPeriodEnd` is (necessarily) already in the past —
   * see `recordFailedCharge()`'s docblock for why a retry now waits for
   * its scheduled slot instead of firing on the very next sweep tick.
   */
  dueAction(now: Date): 'CHARGE' | 'CANCEL' | 'NONE' {
    if (this._status === 'CANCELED') return 'NONE';
    if (this._currentPeriodEnd > now) return 'NONE';
    if (this._cancelAtPeriodEnd) return 'CANCEL';
    if (this._status === 'PAST_DUE' && this._nextRetryAt && now < this._nextRetryAt) return 'NONE';
    return 'CHARGE';
  }

  /**
   * Anchors the new period to the *schedule* (old currentPeriodEnd + one
   * interval), not to `now` — a charge that succeeds after a dunning
   * retry delay still bills the next period on the original cadence,
   * rather than letting retries drift the schedule forward.
   */
  recordSuccessfulCharge(now: Date): void {
    this._currentPeriodStart = this._currentPeriodEnd;
    this._currentPeriodEnd = addBillingInterval(this._currentPeriodEnd, this._interval, this._intervalCount);
    this._status = 'ACTIVE';
    this._failedAttempts = 0;
    this._nextRetryAt = undefined;
    this._lastDeclineCode = undefined;
    this._updatedAt = now;
  }

  /**
   * Does not advance currentPeriodEnd — leaving it in the past means the
   * subscription stays "due" so a later sweep tick can retry the same
   * period (unless this is a hard decline — see below). Sets
   * `nextRetryAt` to gate *when* that retry is allowed to happen
   * (`RETRY_SCHEDULE_DAYS`, indexed by this failure's attempt number)
   * instead of letting `dueAction()` say CHARGE again on the very next
   * sweep tick — the daily sweep used to retry every single day starting
   * immediately after the first failure, compressing what should be
   * roughly a week of dunning into 2-3 days and giving a customer's bank
   * no realistic window to have fixed the problem (insufficient funds, an
   * expired-but-since-updated card) between attempts.
   *
   * `errorCode` — the PSP's own decline code, if it returned one (see
   * `CheckoutSagaResult.errorCode`). `classifyDeclineCode()` decides
   * whether this failure is worth retrying at all: a `HARD_DECLINE`
   * (stolen/lost/fraudulent/expired card, ...) skips the retry schedule
   * entirely and cancels *immediately*, regardless of how few attempts
   * have been made — the same "retrying is actively harmful" reasoning
   * this aggregate's file-level docblock on `HARD_DECLINE_CODES`
   * describes. An unrecognized or absent code (including a routing
   * failure that never reached a PSP) defaults to `RETRYABLE`, the same
   * behavior this method always had before decline codes existed.
   */
  recordFailedCharge(now: Date, maxAttempts: number, errorCode?: string): void {
    this._failedAttempts += 1;
    this._lastDeclineCode = errorCode;
    const isHardDecline = classifyDeclineCode(errorCode) === 'HARD_DECLINE';
    if (isHardDecline || this._failedAttempts >= maxAttempts) {
      this._status = 'CANCELED';
      this._canceledAt = now;
      this._nextRetryAt = undefined;
    } else {
      this._status = 'PAST_DUE';
      const delayDays = RETRY_SCHEDULE_DAYS[Math.min(this._failedAttempts - 1, RETRY_SCHEDULE_DAYS.length - 1)];
      this._nextRetryAt = new Date(now.getTime() + delayDays * 24 * 60 * 60 * 1000);
    }
    this._updatedAt = now;
  }

  /**
   * Whether the most recent `recordFailedCharge()` cancellation was a
   * hard decline (skipped the retry schedule) rather than the schedule
   * running out normally — `SubscriptionService` reads this to pick the
   * right `subscription.canceled` event reason. Meaningless (and
   * `false`) unless `status` is `CANCELED` from a failed charge (not a
   * `cancelAtPeriodEnd`/immediate merchant cancellation, which never set
   * `lastDeclineCode` at all).
   */
  get canceledByHardDecline(): boolean {
    return this._status === 'CANCELED' && classifyDeclineCode(this._lastDeclineCode) === 'HARD_DECLINE';
  }

  /** The cancelAtPeriodEnd due-date arriving, with no charge attempted — see dueAction(). */
  finalizeCancellation(now: Date): void {
    this._status = 'CANCELED';
    this._canceledAt = now;
    this._updatedAt = now;
  }

  /** Explicit merchant/operator-initiated cancellation — POST /subscriptions/:id/cancel. */
  requestCancellation(now: Date, immediate: boolean): void {
    if (this._status === 'CANCELED') return;
    if (immediate) {
      this._status = 'CANCELED';
      this._canceledAt = now;
    } else {
      this._cancelAtPeriodEnd = true;
    }
    this._updatedAt = now;
  }

  /**
   * The prorated *charge* for switching to `newAmount` mid-period, or
   * `undefined` if the switch is a downgrade/lateral move that produces
   * no charge. Only ever returns a charge, never a credit — `Money`
   * can't represent a negative amount (see money.vo.ts), and this system
   * doesn't have an account-credit concept to apply one to anyway. A
   * downgrade's unused-portion "credit" is simply not issued — the price
   * just changes going forward with no adjustment for the current
   * period's already-collected amount. See
   * docs/business-domain/subscriptions.md for the fuller writeup of this
   * simplification.
   *
   * Anchored to the *current* period's actual boundaries
   * (currentPeriodStart/End), not to the interval in the abstract — a
   * period shortened/lengthened by a previous dunning retry still
   * prorates correctly against how long this period actually is.
   */
  computeUpgradeProration(newAmount: Money, now: Date): Money | undefined {
    if (newAmount.currency.code !== this._amount.currency.code) {
      throw new Error(`Cannot change to a plan in a different currency (${this._amount.currency.code} -> ${newAmount.currency.code})`);
    }

    const totalMs = this._currentPeriodEnd.getTime() - this._currentPeriodStart.getTime();
    const remainingMs = Math.max(0, Math.min(totalMs, this._currentPeriodEnd.getTime() - now.getTime()));
    const remainingFraction = totalMs > 0 ? remainingMs / totalMs : 0;

    const oldRemainingValue = this._amount.multiply(remainingFraction);
    const newRemainingValue = newAmount.multiply(remainingFraction);

    if (newRemainingValue.isGreaterThan(oldRemainingValue)) {
      return newRemainingValue.subtract(oldRemainingValue);
    }
    return undefined;
  }

  /**
   * The unused-portion credit for switching to a *cheaper* `newAmount`
   * mid-period — the exact mirror of computeUpgradeProration(), and
   * `undefined` for the same reason in reverse (an upgrade/lateral move
   * produces no credit). Unlike an upgrade's proration, which charges
   * immediately, a downgrade's credit is only ever applied later, against
   * a future period's charge — see applyDowngradeCredit()/
   * amountDueThisPeriod() for why: there's no refund/account-credit
   * primitive to hand it back with immediately, and reducing a *future*
   * charge is the closest approximation this system can make without one.
   */
  computeDowngradeCredit(newAmount: Money, now: Date): Money | undefined {
    if (newAmount.currency.code !== this._amount.currency.code) {
      throw new Error(`Cannot change to a plan in a different currency (${this._amount.currency.code} -> ${newAmount.currency.code})`);
    }

    const totalMs = this._currentPeriodEnd.getTime() - this._currentPeriodStart.getTime();
    const remainingMs = Math.max(0, Math.min(totalMs, this._currentPeriodEnd.getTime() - now.getTime()));
    const remainingFraction = totalMs > 0 ? remainingMs / totalMs : 0;

    const oldRemainingValue = this._amount.multiply(remainingFraction);
    const newRemainingValue = newAmount.multiply(remainingFraction);

    if (oldRemainingValue.isGreaterThan(newRemainingValue)) {
      return oldRemainingValue.subtract(newRemainingValue);
    }
    return undefined;
  }

  /** Accumulates — a second downgrade before the first credit is ever consumed adds to it rather than replacing it. */
  applyDowngradeCredit(credit: Money): void {
    this._pendingCredit = this._pendingCredit ? this._pendingCredit.add(credit) : credit;
  }

  /**
   * What the next billing charge should actually be, after subtracting
   * any pending downgrade credit — never negative, since `Money` can't
   * represent that: a credit larger than the period's price simply caps
   * the charge at zero rather than carrying a "negative bill" anywhere.
   * `SubscriptionService.runBillingSweep()` uses this instead of `amount`
   * directly, and skips calling the PSP entirely when it's zero — a $0
   * charge is nothing to actually charge.
   */
  get amountDueThisPeriod(): Money {
    if (!this._pendingCredit || this._pendingCredit.isZero()) return this._amount;
    return this._amount.isGreaterThan(this._pendingCredit) ? this._amount.subtract(this._pendingCredit) : Money.zero(this._amount.currency.code);
  }

  /**
   * Called once a charge for `amountDueThisPeriod` has actually succeeded
   * (including the zero-charge case) — consumes however much of the
   * pending credit this period actually used, leaving any remainder for a
   * later period. Doesn't touch `_updatedAt` itself; the caller already
   * calls recordSuccessfulCharge() in the same operation, which does.
   */
  consumeCredit(): void {
    if (!this._pendingCredit || this._pendingCredit.isZero()) return;
    const consumed = this._pendingCredit.isGreaterThan(this._amount) ? this._amount : this._pendingCredit;
    const remaining = this._pendingCredit.subtract(consumed);
    // Normalize a fully-consumed credit back to undefined rather than a
    // zero Money — leaving a zero object here would round-trip through
    // Postgres as a real (non-null) "0" value, so a later read would
    // report pendingCredit: 0 instead of omitting it entirely, the same
    // undefined-vs-null distinction this codebase has hit before (see
    // MerchantService.updateSettlementCurrency()'s docblock).
    this._pendingCredit = remaining.isZero() ? undefined : remaining;
  }

  /**
   * Applies a plan change — called by SubscriptionService.changePlan()
   * after any proration charge (computeUpgradeProration()) has already
   * succeeded, or immediately if none was owed. Deliberately does not
   * touch currentPeriodEnd: the new amount/interval take effect for the
   * *next* renewal onward (the current period was already prorated, or
   * was a downgrade that keeps running at the old rate's worth of
   * service through its end) — same "billing sweep drives what actually
   * gets charged" posture as everywhere else in this aggregate.
   */
  applyPlanChange(params: { planId: string; amount: Money; interval: BillingInterval; intervalCount: number }, now: Date): void {
    this._planId = params.planId;
    this._amount = params.amount;
    this._interval = params.interval;
    this._intervalCount = params.intervalCount;
    this._updatedAt = now;
  }

  get id(): string { return this._id; }
  get merchantId(): string { return this._merchantId; }
  get customerId(): string { return this._customerId; }
  get amount(): Money { return this._amount; }
  get interval(): BillingInterval { return this._interval; }
  get intervalCount(): number { return this._intervalCount; }
  get paymentMethodId(): string { return this._paymentMethodId; }
  get status(): SubscriptionStatus { return this._status; }
  get currentPeriodStart(): Date { return this._currentPeriodStart; }
  get currentPeriodEnd(): Date { return this._currentPeriodEnd; }
  get cancelAtPeriodEnd(): boolean { return this._cancelAtPeriodEnd; }
  get failedAttempts(): number { return this._failedAttempts; }
  get orderId(): string | undefined { return this._orderId; }
  get description(): string | undefined { return this._description; }
  get canceledAt(): Date | undefined { return this._canceledAt; }
  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }
  get planId(): string | undefined { return this._planId; }
  get pendingCredit(): Money | undefined { return this._pendingCredit; }
  get nextRetryAt(): Date | undefined { return this._nextRetryAt; }
  get lastDeclineCode(): string | undefined { return this._lastDeclineCode; }
}
