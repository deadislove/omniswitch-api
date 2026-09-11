import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MerchantService } from '../../../merchant/merchant.service';
import { MerchantEntity } from '../../../merchant/merchant.entity';
import { DisputePort } from '../../ports/outbound/dispute.port';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { getDisputeRiskWeight } from '../../domain/services/dispute-risk-weight';
import { ReserveService } from './reserve.service';

// Any status where a real charge actually happened at the PSP — a later
// refund or dispute changes the payment's *current* status but doesn't
// change whether it was ever a settled charge in the first place. Same
// list PaymentTypeOrmRepository.findByProviderAndDateRange() already
// uses for the identical reason (reconciliation's "did this transaction
// really happen" question). Counting only SUCCEEDED would systematically
// *undercount* volume for exactly the merchants this service cares most
// about — a lost dispute moves the payment to REFUNDED, so a merchant's
// riskiest charges would silently fall out of their own denominator.
const SETTLED_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
  PaymentStatus.DISPUTED,
];

const WINDOW_DAYS = 90;
// Below this many settled charges in the window, a merchant's chargeback
// rate is statistical noise (one dispute out of 3 charges is a 33% "rate"
// that means nothing) — leave the reserve policy untouched rather than
// react to a sample too small to mean anything.
const MIN_SAMPLE_SIZE = 10;

// Same order of magnitude as LedgerOutboxRelayService's RELAY_BATCH_SIZE —
// large enough that runTieringSweep() doesn't spend most of its time on
// per-batch round-trip overhead, small enough that concurrently evaluating
// a whole batch (each evaluation does its own couple of DB queries) can't
// exhaust the app's own DB connection pool (DB_POOL_MAX, default 20).
const RISK_TIERING_SWEEP_BATCH_SIZE = 50;

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

interface TierPolicy {
  reserveBps: number;
  reserveHoldDays: number;
}

// Deliberately simple, round thresholds — an illustration of the
// mechanism ("chargeback rate drives reserve rate"), not a calibrated
// underwriting model. MCC code and account tenure now feed in as
// escalation-only modifiers (see escalate() and evaluateMerchant()
// below); dispute *reason* codes (fraud vs. "product not as described"
// carry very different signal) still don't — see
// docs/business-domain/future-directions.md's Merchant Risk Tiering
// section for what's still deliberately out of scope.
const TIER_POLICIES: Record<RiskTier, TierPolicy> = {
  LOW: { reserveBps: 0, reserveHoldDays: 0 },
  MEDIUM: { reserveBps: 500, reserveHoldDays: 30 },
  HIGH: { reserveBps: 1500, reserveHoldDays: 90 },
};

// Trailing lost-dispute rate (LOST disputes / SUCCEEDED charges) over
// WINDOW_DAYS. WON/still-open disputes don't count — a merchant that
// successfully contests every dispute against it isn't actually
// bleeding chargebacks, whatever the raw dispute-creation rate looks
// like. Defaults match the illustrative thresholds this file always
// used — overridable per-deployment (RISK_TIER_HIGH_THRESHOLD/
// RISK_TIER_MEDIUM_THRESHOLD, read in the constructor below) without a
// code change, not "calibrated" on their own; see this file's own
// docblock on TIER_POLICIES for why these are still illustrative.
const DEFAULT_HIGH_RISK_THRESHOLD = 0.01; // >1% lost-dispute rate
const DEFAULT_MEDIUM_RISK_THRESHOLD = 0.005; // >0.5% lost-dispute rate
// A merchant younger than this has no track record yet — same "not
// enough signal" reasoning as MIN_SAMPLE_SIZE, but for account age
// rather than charge volume. Overridable like the rate thresholds above.
const DEFAULT_NEW_MERCHANT_AGE_DAYS = 30;

function tierFor(lostDisputeRate: number, highThreshold: number, mediumThreshold: number): RiskTier {
  if (lostDisputeRate > highThreshold) return 'HIGH';
  if (lostDisputeRate > mediumThreshold) return 'MEDIUM';
  return 'LOW';
}

const TIER_ORDER: RiskTier[] = ['LOW', 'MEDIUM', 'HIGH'];

/** One step up, never down — a modifier can only make a merchant look riskier than the lost-dispute-rate signal alone says, never safer. */
function escalate(tier: RiskTier): RiskTier {
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(tier) + 1, TIER_ORDER.length - 1)];
}

/**
 * Risk Tiering Service
 * Closes the gap the Merchant Risk Tiering & Reserves pass left open:
 * MerchantEntity.reserveBps/reserveHoldDays existed, but nothing decided
 * what they should *be* for a given merchant — an operator set them by
 * hand, and they never changed again on their own. This service
 * recomputes a trailing lost-dispute rate per merchant and adjusts the
 * reserve policy automatically — in both directions: a merchant whose
 * chargeback rate climbs gets a higher reserve/longer hold, and one that
 * cleans up its dispute history tapers back down, not just escalates.
 *
 * Only touches merchants with riskTierAutoManaged = true — an operator's
 * manual PATCH .../reserve-policy call disables it for that merchant (see
 * MerchantEntity's docblock), so a hand-tuned reserve doesn't get
 * silently overwritten by the next sweep tick. Re-enable via
 * PATCH .../risk-tier-auto.
 *
 * De-escalation only ever changes reserveBps/reserveHoldDays going
 * forward — like updateReservePolicy(), it never retroactively touches
 * already-booked ReserveHold records; a merchant's history improving
 * doesn't claw back a reserve already withheld from an earlier charge.
 * **Escalation is different (Phase 1)**: when a merchant's tier goes
 * *up*, still-`HELD` reserves (not yet released) get topped up to the
 * new, higher rate via ReserveService.topUpHeldReservesForMerchant() —
 * a real risk event shouldn't leave older, already-in-flight charges
 * under-reserved just because they were booked before the escalation.
 * One-way by design: only escalation tops up, only de-escalation is
 * forward-only, so an escalate-then-de-escalate cycle can never be used
 * to extract a reserve top-up and then immediately reverse it.
 */
@Injectable()
export class RiskTieringService {
  private readonly logger = new Logger(RiskTieringService.name);
  // `ConfigService.get<number>()` doesn't actually cast (see
  // health.controller.ts's own comment on the same gap) — wrap explicitly.
  private readonly highRiskThreshold: number;
  private readonly mediumRiskThreshold: number;
  private readonly newMerchantAgeDays: number;

  constructor(
    private readonly merchantService: MerchantService,
    private readonly disputePort: DisputePort,
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly reserveService: ReserveService,
    configService: ConfigService,
  ) {
    this.highRiskThreshold = Number(configService.get('RISK_TIER_HIGH_THRESHOLD', DEFAULT_HIGH_RISK_THRESHOLD));
    this.mediumRiskThreshold = Number(configService.get('RISK_TIER_MEDIUM_THRESHOLD', DEFAULT_MEDIUM_RISK_THRESHOLD));
    this.newMerchantAgeDays = Number(
      configService.get('RISK_TIER_NEW_MERCHANT_AGE_DAYS', DEFAULT_NEW_MERCHANT_AGE_DAYS),
    );
  }

  /**
   * Returns the computed tier and whether it caused a change — `null` if
   * there wasn't enough sample size to evaluate at all. Looks the
   * merchant up itself — for any caller that only has a `merchantId`
   * (there's no other caller today; kept for a stable public entry point
   * on this class). `runTieringSweep()` below already has the full
   * `MerchantEntity` from its own batch fetch, so it calls
   * `evaluateMerchantEntity()` directly instead — going through this
   * wrapper would re-fetch a row the sweep just fetched, tripling this
   * sweep's per-merchant round trips for no benefit.
   */
  async evaluateMerchant(merchantId: string, now: Date): Promise<{ tier: RiskTier; changed: boolean } | null> {
    const merchant = await this.merchantService.findByMerchantId(merchantId);
    if (!merchant) return null;
    return this.evaluateMerchantEntity(merchant, now);
  }

  private async evaluateMerchantEntity(
    merchant: MerchantEntity,
    now: Date,
  ): Promise<{ tier: RiskTier; changed: boolean } | null> {
    // This class's own docblock says "only touches merchants with
    // riskTierAutoManaged = true" — until this check existed, that was
    // only actually enforced by runTieringSweep()'s upstream batch query
    // (findActiveAutoManagedBatch()), not by this method itself. A caller
    // reaching this through the public evaluateMerchant(merchantId, now)
    // wrapper (Phase 2's DisputeService, reading a tier for the dispute
    // auto-decision policy) had no such upstream filter and would
    // silently recompute — and, via applyAutoRiskTier() below,
    // overwrite — a manually-overridden merchant's reserveBps/
    // reserveHoldDays just by evaluating them for an unrelated purpose.
    // Enforcing the invariant here closes it for every caller, not just
    // the sweep. `null` here means the same thing it means for
    // insufficient sample size below: no confident auto-computed answer,
    // callers treat that as "no tier signal" (e.g. dispute-policy.ts
    // falls back to its MEDIUM-equivalent default).
    if (!merchant.riskTierAutoManaged) {
      return null;
    }

    const merchantId = merchant.merchantId;
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [settledCounts, lostDisputeReasons] = await Promise.all([
      Promise.all(
        SETTLED_STATUSES.map((status) =>
          this.paymentRepository.count({ merchantId, status, fromDate: since, toDate: now }),
        ),
      ),
      this.disputePort.findReasonsByMerchantStatusSince(merchantId, 'LOST', since),
    ]);
    const settledCharges = settledCounts.reduce((sum, n) => sum + n, 0);
    // Reason-weighted, not a raw count — a `fraudulent` loss and a
    // `duplicate` loss carry very different risk signal about the
    // merchant itself. See dispute-risk-weight.ts.
    const lostDisputes = lostDisputeReasons.reduce((sum, reason) => sum + getDisputeRiskWeight(reason), 0);

    if (settledCharges < MIN_SAMPLE_SIZE) {
      return null;
    }

    const lostDisputeRate = lostDisputes / settledCharges;
    let tier = tierFor(lostDisputeRate, this.highRiskThreshold, this.mediumRiskThreshold);
    const reasons = [
      `${(lostDisputeRate * 100).toFixed(2)}% lost-dispute rate over ${settledCharges} charges/${WINDOW_DAYS}d`,
    ];

    // Modifiers only ever escalate — see escalate()'s own comment. A
    // merchant with a clean dispute history but a high-risk MCC or no
    // track record yet isn't "safe," the lost-dispute-rate signal just
    // hasn't caught up to them; it should never work the other way
    // (a bad dispute history isn't excused by a low-risk MCC).
    if (merchant.industryRiskCategory === 'HIGH') {
      tier = escalate(tier);
      reasons.push('high-risk MCC');
    }
    const accountAgeDays = (now.getTime() - merchant.createdAt.getTime()) / (24 * 60 * 60 * 1000);
    if (accountAgeDays < this.newMerchantAgeDays) {
      tier = escalate(tier);
      reasons.push(`account age ${accountAgeDays.toFixed(0)}d < ${this.newMerchantAgeDays}d`);
    }
    // kycStatus is only meaningful for CONNECTED merchants (see
    // MerchantEntity's docblock) — a PLATFORM merchant's kycStatus stays
    // NOT_STARTED forever by design, so gating on it for PLATFORM
    // merchants would force every one of them to HIGH.
    if (merchant.accountType === 'CONNECTED' && merchant.kycStatus !== 'VERIFIED') {
      tier = 'HIGH';
      reasons.push(`KYC ${merchant.kycStatus}`);
    }

    const policy = TIER_POLICIES[tier];
    const isEscalation = policy.reserveBps > merchant.reserveBps;
    const changed = merchant.reserveBps !== policy.reserveBps || merchant.reserveHoldDays !== policy.reserveHoldDays;

    if (changed) {
      await this.merchantService.applyAutoRiskTier(merchantId, policy.reserveBps, policy.reserveHoldDays);
      this.logger.log(
        `Risk tier for merchant ${merchantId} -> ${tier} (${reasons.join(', ')}) — ` +
          `reserve now ${policy.reserveBps}bps/${policy.reserveHoldDays}d`,
      );

      // Escalation only — a de-escalation (merchant's history improved)
      // never claws back a reserve already withheld from an earlier
      // charge; see ReserveService.topUpHeldReservesForMerchant()'s own
      // docblock and this class's module docs.
      if (isEscalation) {
        const { toppedUp, failed } = await this.reserveService.topUpHeldReservesForMerchant(
          merchantId,
          policy.reserveBps,
        );
        if (toppedUp > 0 || failed > 0) {
          this.logger.log(
            `Risk tier escalation for merchant ${merchantId}: topped up ${toppedUp} still-HELD reserve hold(s) to ${policy.reserveBps}bps, ${failed} failed`,
          );
        }
      }
    }

    return { tier, changed };
  }

  /**
   * Daily sweep — every auto-managed, active merchant gets re-evaluated.
   * Also exposed on demand via POST /admin/risk-tiering/run (same dual
   * on-demand + scheduled shape as ReconciliationService/ReserveService/
   * SubscriptionService's billing sweep).
   *
   * Batched (RISK_TIERING_SWEEP_BATCH_SIZE) + concurrent-within-a-batch
   * (`Promise.allSettled`), not `merchantService.list()` fetched wholesale
   * and evaluated one at a time — that was the original shape, and it
   * scales linearly with the *total* merchant count (fetches and iterates
   * every merchant ever created, active or not, auto-managed or not,
   * filtering in application code), which is fine at a few dozen
   * merchants but measured at 11+ seconds *per call* against ~8,500
   * merchants — several real-suite e2e tests call this sweep twice, which
   * compounds past Jest's 60s test timeout under full-suite load. The SQL
   * filter (`findActiveAutoManagedBatch`) also means a batch never
   * contains a row this sweep was going to skip anyway.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'risk-tiering-sweep' })
  async runTieringSweep(now: Date = new Date()): Promise<{ evaluated: number; changed: number; skipped: number }> {
    let evaluated = 0;
    let changed = 0;
    let skipped = 0;
    let totalCandidates = 0;
    let afterId: string | undefined;

    for (;;) {
      const batch = await this.merchantService.findActiveAutoManagedBatch(afterId, RISK_TIERING_SWEEP_BATCH_SIZE);
      if (batch.length === 0) break;
      totalCandidates += batch.length;

      const results = await Promise.allSettled(batch.map((merchant) => this.evaluateMerchantEntity(merchant, now)));
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          skipped++;
          const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.logger.error(`Risk tiering sweep: failed to evaluate merchant ${batch[i].merchantId}: ${msg}`);
          return;
        }
        if (result.value === null) {
          skipped++;
        } else {
          evaluated++;
          if (result.value.changed) changed++;
        }
      });

      afterId = batch[batch.length - 1].id;
      if (batch.length < RISK_TIERING_SWEEP_BATCH_SIZE) break;
    }

    if (totalCandidates > 0) {
      this.logger.log(
        `Risk tiering sweep: ${evaluated} evaluated (${changed} changed), ${skipped} skipped, ${totalCandidates} auto-managed merchants`,
      );
    }
    return { evaluated, changed, skipped };
  }
}
