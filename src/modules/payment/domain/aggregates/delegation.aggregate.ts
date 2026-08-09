import { Money } from '../value-objects/money.vo';
import { SpendPolicy } from '../value-objects/spend-policy.vo';

export type DelegationStatus = 'ACTIVE' | 'REVOKED';

/** Calendar-month bucket key (UTC) — e.g. "2026-08". Rolling over on this boundary, not "30 days since creation", matches how a real card's monthly spend limit resets. */
export function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Delegation Aggregate
 * A human principal (a merchant's own operator) authorizing an autonomous
 * agent to make purchases on the merchant's behalf — a narrower, revocable
 * slice of purchasing power, not the merchant's own full account access.
 * See docs/business-domain/future-directions.md#agentic-payments for why
 * this is a genuinely different relationship than the RBAC roles
 * (`UserRole.MERCHANT`/`ADMIN`/...) that already exist, and
 * DEV_README.md's "AI agents / agentic payments" section for the
 * technical framing.
 *
 * Creating one immediately issues its one agent JWT (`jti`/`tokenExpiresAt`
 * below) — see DelegationService.createDelegation(). There is deliberately
 * no separate "rotate token" flow for this MVP: a delegation whose token
 * has leaked is revoked and a new one created, the same posture a
 * compromised API key already has in this codebase.
 *
 * `_currentMonthSpent` is a rolling accumulator against `spendPolicy`'s
 * `monthlyLimit`, reset whenever `spentThisMonth()`/the repository's
 * atomic reservation observes a new calendar month (see
 * DelegationTypeOrmRepository.tryReserveSpend()) — mirrors how
 * `Subscription.pendingCredit` accumulates state directly on the
 * aggregate rather than being derived by scanning historical `Payment`
 * rows on every check.
 */
export class Delegation {
  private constructor(
    private readonly _id: string,
    private readonly _merchantId: string,
    private readonly _agentName: string,
    private readonly _spendPolicy: SpendPolicy,
    private _status: DelegationStatus,
    private _currentMonthKey: string,
    private _currentMonthSpent: Money,
    private readonly _jti: string,
    private readonly _tokenExpiresAt: Date,
    private readonly _createdAt: Date,
    private _revokedAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  static create(params: {
    id: string;
    merchantId: string;
    agentName: string;
    spendPolicy: SpendPolicy;
    jti: string;
    tokenExpiresAt: Date;
  }): Delegation {
    const now = new Date();
    return new Delegation(
      params.id,
      params.merchantId,
      params.agentName,
      params.spendPolicy,
      'ACTIVE',
      monthKeyOf(now),
      Money.zero(params.spendPolicy.currency),
      params.jti,
      params.tokenExpiresAt,
      now,
      undefined,
      now,
    );
  }

  static reconstitute(params: {
    id: string;
    merchantId: string;
    agentName: string;
    spendPolicy: SpendPolicy;
    status: DelegationStatus;
    currentMonthKey: string;
    currentMonthSpent: Money;
    jti: string;
    tokenExpiresAt: Date;
    createdAt: Date;
    revokedAt?: Date;
    updatedAt: Date;
  }): Delegation {
    return new Delegation(
      params.id,
      params.merchantId,
      params.agentName,
      params.spendPolicy,
      params.status,
      params.currentMonthKey,
      params.currentMonthSpent,
      params.jti,
      params.tokenExpiresAt,
      params.createdAt,
      params.revokedAt,
      params.updatedAt,
    );
  }

  /** Read-only, does not mutate — the actual month rollover is applied atomically by the repository at reservation time. Used here only to give a precise, current "remaining budget" figure for error messages/API responses. */
  spentThisMonth(now: Date): Money {
    return monthKeyOf(now) === this._currentMonthKey ? this._currentMonthSpent : Money.zero(this._spendPolicy.currency);
  }

  revoke(now: Date = new Date()): void {
    this._status = 'REVOKED';
    this._revokedAt = now;
    this._updatedAt = now;
  }

  get id(): string { return this._id; }
  get merchantId(): string { return this._merchantId; }
  get agentName(): string { return this._agentName; }
  get spendPolicy(): SpendPolicy { return this._spendPolicy; }
  get status(): DelegationStatus { return this._status; }
  get currentMonthKey(): string { return this._currentMonthKey; }
  get currentMonthSpent(): Money { return this._currentMonthSpent; }
  get jti(): string { return this._jti; }
  get tokenExpiresAt(): Date { return this._tokenExpiresAt; }
  get createdAt(): Date { return this._createdAt; }
  get revokedAt(): Date | undefined { return this._revokedAt; }
  get updatedAt(): Date { return this._updatedAt; }
}
