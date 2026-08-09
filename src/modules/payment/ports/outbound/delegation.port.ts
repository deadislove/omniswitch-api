import { Delegation, DelegationStatus } from '../../domain/aggregates/delegation.aggregate';
import { Money } from '../../domain/value-objects/money.vo';

export interface FindDelegationsFilter {
  merchantId?: string;
  status?: DelegationStatus;
  limit?: number;
}

export abstract class DelegationPort {
  abstract save(delegation: Delegation): Promise<void>;
  abstract findById(id: string): Promise<Delegation | null>;
  abstract findMany(filter?: FindDelegationsFilter): Promise<Delegation[]>;

  /**
   * Atomically rolls the delegation's spend counter over to `now`'s
   * calendar month if needed, then reserves `amount` against it IFF the
   * delegation is ACTIVE and the reservation doesn't exceed either the
   * per-transaction or the (post-rollover) monthly limit — all in one
   * row-locked UPDATE, so two concurrent charges against the same
   * delegation can't both succeed past the monthly cap. This is the real
   * race-safe enforcement gate; DelegationService's own checks before
   * calling this exist only to produce a precise error message. Returns
   * false (nothing reserved) if any condition fails.
   */
  abstract tryReserveSpend(delegationId: string, amount: Money, now: Date): Promise<boolean>;

  /**
   * Compensating release for a reservation whose charge subsequently
   * failed (PSP decline, routing failure) — mirrors the saga's other
   * compensating-transaction steps. Best-effort: if a calendar-month
   * rollover happened in the brief window between reserve and release
   * (practically never, given a charge completes in milliseconds), this
   * decrements whatever the current bucket is rather than blocking on an
   * exact month match — a documented simplification, not silently wrong
   * money movement (nothing here settles real funds).
   */
  abstract releaseSpend(delegationId: string, amount: Money): Promise<void>;
}
