import { Money } from '../value-objects/money.vo';
import { BillingInterval } from './subscription.aggregate';

/**
 * Plan Aggregate
 * A reusable subscription template a merchant defines once and subscribes
 * many customers to — lets a multi-product merchant define "Pro Monthly,
 * $29/mo" once and reuse it, rather than every subscription carrying its
 * own amount/interval directly with no shared catalog entry behind it.
 *
 * Deliberately immutable once created (no "edit a plan's price" — only
 * `deactivate()`, which stops it being offered for *new* subscriptions or
 * plan changes). Real billing systems treat an existing plan's price as
 * effectively frozen for the same reason a payment's amount can't be
 * edited after the fact: a subscriber who signed up at $29/mo shouldn't
 * silently start paying $39/mo because an operator edited the Plan row.
 * A price change is a new Plan, not a mutation of an old one — the
 * (separately built) plan-change/proration flow is how an existing
 * subscriber ever moves to it.
 *
 * A subscription that used a Plan snapshots its amount/interval at
 * creation/change time rather than holding a live reference — see
 * Subscription.planId's docblock — so `deactivate()` here never affects
 * an already-subscribed customer.
 */
export class Plan {
  private constructor(
    private readonly _id: string,
    private readonly _merchantId: string,
    private readonly _name: string,
    private readonly _amount: Money,
    private readonly _interval: BillingInterval,
    private readonly _intervalCount: number,
    private _isActive: boolean,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static create(params: {
    id: string;
    merchantId: string;
    name: string;
    amount: Money;
    interval: BillingInterval;
    intervalCount: number;
  }): Plan {
    const now = new Date();
    return new Plan(params.id, params.merchantId, params.name, params.amount, params.interval, params.intervalCount, true, now, now);
  }

  static reconstitute(params: {
    id: string;
    merchantId: string;
    name: string;
    amount: Money;
    interval: BillingInterval;
    intervalCount: number;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): Plan {
    return new Plan(params.id, params.merchantId, params.name, params.amount, params.interval, params.intervalCount, params.isActive, params.createdAt, params.updatedAt);
  }

  deactivate(now: Date = new Date()): void {
    this._isActive = false;
    this._updatedAt = now;
  }

  get id(): string { return this._id; }
  get merchantId(): string { return this._merchantId; }
  get name(): string { return this._name; }
  get amount(): Money { return this._amount; }
  get interval(): BillingInterval { return this._interval; }
  get intervalCount(): number { return this._intervalCount; }
  get isActive(): boolean { return this._isActive; }
  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }
}
