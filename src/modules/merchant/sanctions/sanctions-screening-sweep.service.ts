import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MerchantService } from '../merchant.service';
import { SanctionsScreeningService } from './sanctions-screening.service';
import { SanctionsNotificationDispatcherService } from './sanctions-notification-dispatcher.service';

// Same order-of-magnitude reasoning as RISK_TIERING_SWEEP_BATCH_SIZE —
// large enough to avoid per-batch round-trip overhead dominating a full
// sweep, small enough that a concurrently-evaluated batch (each
// evaluation is one external screening call) can't exhaust this app's
// own DB connection pool.
const SANCTIONS_SWEEP_BATCH_SIZE = 50;

/**
 * Sanctions Screening Sweep Service
 * A merchant clean at onboarding can appear on a real sanctions list
 * later — this is the mechanism that catches that, re-screening every
 * active merchant not already `HIT` on a weekly schedule (same
 * batched + `Promise.allSettled` shape `RiskTieringService`'s daily
 * sweep uses) and on demand (`POST /admin/sanctions/run`).
 *
 * Unlike onboarding/KYC-submit screening, a `HIT` found here does
 * **not** throw or undo anything — there's no in-flight request to
 * block. It's persisted and notified exactly like a `POTENTIAL_MATCH`;
 * freezing balances, blocking payouts, or deactivating the merchant
 * outright are deliberately left to a human decision via existing tools
 * (`PATCH .../status`, `PATCH .../reserve-policy`) rather than this
 * sweep taking a consequential, hard-to-reverse action unilaterally —
 * see docs/business-domain/risk-and-fraud.md#sanctionswatchlist-screening-onboarding--periodic-re-screening.
 *
 * Notifies only when the status actually changed to something
 * worth a human's attention (`POTENTIAL_MATCH`/`HIT`, and only if it
 * wasn't already that same status) — re-notifying every week for an
 * already-known, already-reviewed flag would just be noise, the same
 * "already flagged, don't re-notify" reasoning
 * `AmlReviewMonitoringService`'s own already-flagged branch uses.
 */
@Injectable()
export class SanctionsScreeningSweepService {
  private readonly logger = new Logger(SanctionsScreeningSweepService.name);

  constructor(
    private readonly merchantService: MerchantService,
    private readonly sanctionsScreening: SanctionsScreeningService,
    private readonly notificationDispatcher: SanctionsNotificationDispatcherService,
  ) {}

  private async evaluateOne(merchant: {
    merchantId: string;
    name: string;
    legalName?: string | null;
    taxId?: string | null;
    sanctionsScreeningStatus: string;
  }): Promise<{ newHit: boolean; newPotentialMatch: boolean }> {
    const previousStatus = merchant.sanctionsScreeningStatus;
    const screening = await this.sanctionsScreening.screen({
      legalName: merchant.legalName,
      displayName: merchant.name,
      taxId: merchant.taxId,
    });
    await this.merchantService.applySanctionsScreeningResult(merchant.merchantId, screening);

    const isNew = screening.status !== previousStatus;
    if (isNew && screening.status !== 'CLEAR') {
      await this.notificationDispatcher.notify({
        event: 'sanctions_screening.flagged',
        merchantId: merchant.merchantId,
        status: screening.status,
        matchedListEntry: screening.matchedListEntry,
        score: screening.score,
        confidence: screening.confidence,
      });
    }
    return {
      newHit: isNew && screening.status === 'HIT',
      newPotentialMatch: isNew && screening.status === 'POTENTIAL_MATCH',
    };
  }

  @Cron(CronExpression.EVERY_WEEK, { name: 'sanctions-screening-sweep' })
  async runSweep(): Promise<{ screened: number; newHits: number; newPotentialMatches: number; skipped: number }> {
    let screened = 0;
    let newHits = 0;
    let newPotentialMatches = 0;
    let skipped = 0;
    let totalCandidates = 0;
    let afterId: string | undefined;

    for (;;) {
      const batch = await this.merchantService.findActiveNotHitBatch(afterId, SANCTIONS_SWEEP_BATCH_SIZE);
      if (batch.length === 0) break;
      totalCandidates += batch.length;

      const results = await Promise.allSettled(batch.map((merchant) => this.evaluateOne(merchant)));
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          skipped++;
          const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.logger.error(`Sanctions sweep: failed to screen merchant ${batch[i].merchantId}: ${msg}`);
          return;
        }
        screened++;
        if (result.value.newHit) newHits++;
        if (result.value.newPotentialMatch) newPotentialMatches++;
      });

      afterId = batch[batch.length - 1].id;
      if (batch.length < SANCTIONS_SWEEP_BATCH_SIZE) break;
    }

    if (totalCandidates > 0) {
      this.logger.log(
        `Sanctions sweep: ${screened} screened (${newHits} new hits, ${newPotentialMatches} new potential matches), ${skipped} skipped, ${totalCandidates} candidates`,
      );
    }
    return { screened, newHits, newPotentialMatches, skipped };
  }
}
