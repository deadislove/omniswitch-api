import { Money } from '../value-objects/money.vo';

/**
 * Basis points charged for choosing the instant payout rail over the
 * standard one — a deliberately simplified, illustrative stand-in for
 * real Stripe Instant Payouts' published rate (around 1% for a debit
 * card payout), same "round number in the real neighborhood" posture
 * `interchange-rate-table.ts`'s own rates already use.
 */
export const INSTANT_PAYOUT_FEE_BPS = 150;

/**
 * The premium charged for settling a payout via the instant rail
 * instead of the standard one — deducted from `Payout.netAmount` at
 * transfer time (see `PayoutService.initiateTransfer()`), not baked
 * into the sweep's original net/reserve split, since the rail choice
 * happens later and can vary per transfer.
 */
export function calculateInstantPayoutFee(amount: Money): Money {
  return amount.multiply(INSTANT_PAYOUT_FEE_BPS / 10_000);
}
