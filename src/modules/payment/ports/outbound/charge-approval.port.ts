import { ChargeApproval, ChargeApprovalStatus } from '../../domain/aggregates/charge-approval.aggregate';

export interface FindChargeApprovalsFilter {
  merchantId?: string;
  delegationId?: string;
  status?: ChargeApprovalStatus;
  limit?: number;
}

/**
 * Charge Approval Port (Outbound)
 * Persistence contract for the human-approval hold state a `Delegation`'s
 * `SpendPolicy.requireApprovalAboveAmount` creates — see
 * `ChargeApproval`'s own docblock and `ChargeApprovalService`.
 */
export abstract class ChargeApprovalPort {
  abstract save(approval: ChargeApproval): Promise<void>;

  abstract findById(id: string): Promise<ChargeApproval | null>;

  abstract findMany(filter?: FindChargeApprovalsFilter): Promise<ChargeApproval[]>;

  /**
   * Atomic, conditional on status currently being PENDING — an operator's
   * approve/deny click racing a second click (a double-submit, or two
   * operators acting on the same approval) must not both succeed, since
   * approval is the one action here that goes on to actually move money.
   * Returns false if the condition didn't hold, same pattern as
   * `PayoutPort.markReserveReleased()`.
   */
  abstract markApproved(id: string, now: Date, decidedBy: string): Promise<boolean>;

  abstract markDenied(id: string, now: Date, decidedBy: string, reason?: string): Promise<boolean>;
}
