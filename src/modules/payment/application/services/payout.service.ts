import { Injectable, Logger, NotFoundException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID as uuidv4 } from 'crypto';
import { PayoutPort, FindPayoutsFilter } from '../../ports/outbound/payout.port';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { BankTransferPort } from '../../ports/outbound/bank-transfer.port';
import { CachePort } from '../../ports/outbound/cache.port';
import { Payout } from '../../domain/aggregates/payout.aggregate';
import { PayoutSweepRun } from '../../domain/aggregates/payout-sweep-run.aggregate';
import { Money } from '../../domain/value-objects/money.vo';
import { MerchantService } from '../../../merchant/merchant.service';

const SWEEP_LOCK_KEY = 'payout-sweep-lock';
// Generous relative to how long a sweep actually takes (one DB write per
// eligible merchant) — this only needs to survive a legitimately slow run,
// not be tight. Same SETNX-lock primitive IdempotencyInterceptor already
// uses, just a longer TTL for a batch job instead of a single HTTP request.
const SWEEP_LOCK_TTL_SECONDS = 300;

/**
 * Payout Service
 * Marketplace payout scheduling (phase 2 of splits — see
 * docs/business-domain/ledger-and-settlement.md#marketplace-splits). A
 * split already credits a CONNECTED merchant's `MERCHANT` ledger balance
 * at charge time; this service batches that balance into scheduled
 * `Payout` records instead of treating it as immediately available,
 * withholding a rolling reserve the same way a real marketplace processor
 * would. See `Payout`'s docblock for why this doesn't move any ledger
 * money itself — it's a scheduling overlay on a balance that's already
 * correctly booked.
 *
 * Same dual on-demand + scheduled shape as ReconciliationService/
 * ReserveService: `runSweep()` is both the daily `@Cron` job and
 * `POST /admin/marketplace/run-payouts`.
 */
@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    private readonly payoutPort: PayoutPort,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly merchantService: MerchantService,
    private readonly bankTransfer: BankTransferPort,
    private readonly cache: CachePort,
  ) {}

  /**
   * Returns `null` if another sweep is already in progress (a concurrent
   * `@Cron` tick on a different replica, or an operator's on-demand trigger
   * overlapping one), rather than racing it — see the `SWEEP_LOCK_KEY`
   * acquire below. Verified live: two concurrent calls sharing the same
   * `now` (simulating two pods' `@Cron` handlers firing at the same
   * instant) previously both read `findLatestSweepRun()` before either
   * wrote its own `PayoutSweepRun`, and both created a `Payout` for the
   * same underlying ledger credit — a real double payout, not a
   * hypothetical one.
   */
  @Cron(CronExpression.EVERY_DAY_AT_NOON, { name: 'marketplace-payout-sweep' })
  async runSweep(now: Date = new Date()): Promise<PayoutSweepRun | null> {
    const lockAcquired = await this.cache.setNX(SWEEP_LOCK_KEY, new Date().toISOString(), SWEEP_LOCK_TTL_SECONDS);
    if (!lockAcquired) {
      this.logger.warn('Payout sweep skipped: another sweep is already in progress');
      return null;
    }

    try {
      return await this.runSweepLocked(now);
    } finally {
      await this.cache.del(SWEEP_LOCK_KEY);
    }
  }

  private async runSweepLocked(now: Date): Promise<PayoutSweepRun> {
    const lastRun = await this.payoutPort.findLatestSweepRun();
    const windowStart = lastRun?.windowEnd ?? new Date(0);
    const windowEnd = now;

    const events = await this.ledgerOutbox.findCreatedBetween(windowStart, windowEnd);

    // Net MERCHANT-entry balance per (accountId, currency) in this window —
    // credits positive, debits (refund/dispute-loss reversals) negative.
    // Keyed by currency too, not just accountId: a CONNECTED merchant's
    // platform could charge different customers in different currencies
    // (splits don't require a single currency per platform, only per
    // charge), so one merchant can accumulate balances in more than one
    // currency within a single window — each becomes its own Payout, Money
    // itself can't mix currencies in one arithmetic op. Not scoped to
    // CONNECTED merchants yet; that check happens per-accountId below,
    // since an accountId here could just as easily be a PLATFORM
    // merchant's own charge proceeds, which this sweep doesn't touch.
    const netByAccount = new Map<string, { merchantId: string; currencyCode: string; minorUnits: bigint }>();
    for (const event of events) {
      for (const entry of event.entries) {
        if (entry.accountType !== 'MERCHANT') continue;
        const sign = entry.entryType === 'CREDIT' ? 1n : -1n;
        const currencyCode = entry.amount.currency.code;
        const key = `${entry.accountId}:${currencyCode}`;
        const existing = netByAccount.get(key);
        if (existing) {
          existing.minorUnits += sign * entry.amount.amountMinorUnits;
        } else {
          netByAccount.set(key, { merchantId: entry.accountId, currencyCode, minorUnits: sign * entry.amount.amountMinorUnits });
        }
      }
    }

    const sweepRunId = uuidv4();
    let connectedMerchantsPaid = 0;

    for (const balance of netByAccount.values()) {
      if (balance.minorUnits <= 0n) continue;

      const merchantId = balance.merchantId;
      const merchant = await this.merchantService.findByMerchantId(merchantId);
      if (!merchant || merchant.accountType !== 'CONNECTED') continue;

      const grossAmount = Money.fromMinorUnits(balance.minorUnits, balance.currencyCode);
      const kycVerified = merchant.kycStatus === 'VERIFIED';
      const payout = Payout.create({
        id: uuidv4(),
        merchantId,
        sweepRunId,
        grossAmount,
        reserveBps: merchant.payoutReserveBps,
        reserveHoldDays: merchant.payoutReserveHoldDays,
        kycVerified,
      });
      await this.payoutPort.save(payout);
      connectedMerchantsPaid++;
      this.logger.log(
        `Payout ${payout.id}: ${merchantId} gross=${grossAmount.toString()} net=${payout.netAmount.toString()}` +
          (payout.reserveAmount.isZero() ? '' : ` reserve=${payout.reserveAmount.toString()} (eligible ${payout.releaseEligibleAt!.toISOString()})`) +
          (kycVerified ? '' : ' [KYC_BLOCKED]'),
      );
    }

    const run = PayoutSweepRun.create({ id: sweepRunId, windowStart, windowEnd, connectedMerchantsPaid });
    await this.payoutPort.saveSweepRun(run);

    if (connectedMerchantsPaid > 0) {
      this.logger.log(`Payout sweep ${run.id}: ${connectedMerchantsPaid} connected merchant(s) paid, window [${windowStart.toISOString()} - ${windowEnd.toISOString()}]`);
    }
    return run;
  }

  async findMany(filter?: FindPayoutsFilter): Promise<Payout[]> {
    return this.payoutPort.findMany(filter);
  }

  async findById(id: string): Promise<Payout | null> {
    return this.payoutPort.findById(id);
  }

  /** `force: true` is the manual-override path (bypasses releaseEligibleAt) — the scheduled sweep below never passes it. */
  async releaseReserve(id: string, options: { force?: boolean } = {}): Promise<Payout> {
    const payout = await this.payoutPort.findById(id);
    if (!payout) {
      throw new NotFoundException({ statusCode: 404, error: `Payout ${id} not found`, code: 'PAYOUT_NOT_FOUND' });
    }
    if (payout.reserveAmount.isZero()) {
      throw new ConflictException({ statusCode: 409, error: `Payout ${id} has no reserve to release`, code: 'PAYOUT_HAS_NO_RESERVE' });
    }
    if (payout.reserveReleased) {
      throw new ConflictException({ statusCode: 409, error: `Payout ${id}'s reserve is already released`, code: 'PAYOUT_RESERVE_ALREADY_RELEASED' });
    }
    const now = new Date();
    if (!options.force && payout.releaseEligibleAt && now < payout.releaseEligibleAt) {
      throw new ConflictException({
        statusCode: 409,
        error: `Payout ${id}'s reserve is not yet eligible for release (eligible at ${payout.releaseEligibleAt.toISOString()})`,
        code: 'PAYOUT_RESERVE_NOT_YET_ELIGIBLE',
      });
    }

    const released = await this.payoutPort.markReserveReleased(id, now);
    if (!released) {
      throw new ConflictException({ statusCode: 409, error: `Payout ${id}'s reserve lost a race with another release attempt`, code: 'PAYOUT_RESERVE_ALREADY_RELEASED' });
    }

    // Return the in-memory aggregate, mutated to match what was just
    // committed — not a re-fetch. Same "don't re-fetch after your own
    // write" posture ReserveService.release() already uses, for the same
    // replica-lag reason.
    payout.releaseReserve(now, options.force ?? false);
    this.logger.log(`Payout ${id}'s reserve released (${payout.reserveAmount.toString()}) for merchant ${payout.merchantId}${options.force ? ' [forced]' : ''}`);
    return payout;
  }

  /**
   * Daily sweep — releases every eligible payout reserve. Also exposed on
   * demand via POST /admin/marketplace/release-eligible-reserves.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'marketplace-payout-reserve-release-sweep' })
  async releaseEligibleReserves(now: Date = new Date()): Promise<{ released: number; failed: number }> {
    const payouts = await this.payoutPort.findReserveReleaseEligible(now);
    let released = 0;
    let failed = 0;

    for (const payout of payouts) {
      try {
        await this.releaseReserve(payout.id, { force: false });
        released++;
      } catch (err: unknown) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Payout reserve release sweep: failed to release payout ${payout.id}: ${msg}`);
      }
    }

    if (payouts.length > 0) {
      this.logger.log(`Payout reserve release sweep: ${released} released, ${failed} failed, ${payouts.length} eligible`);
    }
    return { released, failed };
  }

  /**
   * Daily sweep — re-checks every currently KYC-blocked Payout against
   * the recipient's *current* MerchantEntity.kycStatus and clears the
   * block once it's VERIFIED. Also exposed on demand via
   * POST /admin/marketplace/recheck-kyc-blocks. A Payout created while a
   * merchant's KYC was still NOT_STARTED (or REJECTED) stays blocked
   * indefinitely until this finds it VERIFIED — there's no
   * releaseEligibleAt-style timer for a KYC block, unlike the rolling
   * reserve, since "wait N days" doesn't mean anything for a status a
   * human reviewer decides.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: 'marketplace-payout-kyc-recheck' })
  async recheckKycBlocks(): Promise<{ cleared: number }> {
    const blocked = await this.payoutPort.findKycBlocked();
    let cleared = 0;

    for (const payout of blocked) {
      try {
        const merchant = await this.merchantService.findByMerchantId(payout.merchantId);
        if (merchant?.kycStatus !== 'VERIFIED') continue;

        const now = new Date();
        const didClear = await this.payoutPort.markKycCleared(payout.id, now);
        if (didClear) cleared++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Payout KYC recheck: failed to clear payout ${payout.id}: ${msg}`);
      }
    }

    if (blocked.length > 0) {
      this.logger.log(`Payout KYC recheck: ${cleared} cleared, ${blocked.length} still blocked or unchanged`);
    }
    return { cleared };
  }

  /**
   * Initiates a real (mocked) bank transfer for a Payout's `netAmount` —
   * see BankTransferPort and Payout.recordTransferInitiated()'s docblock
   * for why this only ever covers `netAmount`, never a later-released
   * reserve. Throws on a PSP-level decline (same posture as a normal
   * charge/capture/refund) since this is the single on-demand endpoint a
   * caller is waiting on; the sweep version below catches per-item
   * instead so one merchant's declined transfer doesn't block the rest.
   */
  async initiateTransfer(payoutId: string): Promise<Payout> {
    const payout = await this.payoutPort.findById(payoutId);
    if (!payout) {
      throw new NotFoundException({ statusCode: 404, error: `Payout ${payoutId} not found`, code: 'PAYOUT_NOT_FOUND' });
    }
    if (payout.kycBlocked) {
      throw new ConflictException({ statusCode: 409, error: `Payout ${payoutId} is KYC-blocked, cannot initiate a transfer`, code: 'PAYOUT_KYC_BLOCKED' });
    }
    if (payout.netAmount.isZero()) {
      throw new ConflictException({ statusCode: 409, error: `Payout ${payoutId} has no net amount to transfer`, code: 'PAYOUT_NO_TRANSFERABLE_AMOUNT' });
    }
    if (payout.transferStatus === 'INITIATED') {
      throw new ConflictException({ statusCode: 409, error: `Payout ${payoutId}'s transfer is already initiated`, code: 'PAYOUT_TRANSFER_ALREADY_INITIATED' });
    }

    const idempotencyKey = uuidv4();
    const result = await this.bankTransfer.initiateTransfer({
      merchantId: payout.merchantId,
      amount: payout.netAmount,
      idempotencyKey,
    });

    if (!result.success) {
      await this.payoutPort.markTransferFailed(payoutId, result.errorMessage ?? 'Bank transfer declined');
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: result.errorMessage ?? 'Bank transfer declined',
        code: 'PAYOUT_TRANSFER_FAILED',
      });
    }

    const now = new Date();
    const initiated = await this.payoutPort.markTransferInitiated(payoutId, result.transferId!, now);
    if (!initiated) {
      throw new ConflictException({ statusCode: 409, error: `Payout ${payoutId}'s transfer lost a race with another initiation attempt`, code: 'PAYOUT_TRANSFER_ALREADY_INITIATED' });
    }

    // Return the in-memory aggregate, mutated to match what was just
    // committed — same "don't re-fetch after your own write" posture as
    // releaseReserve() above.
    payout.recordTransferInitiated(result.transferId!, now);
    this.logger.log(`Payout ${payoutId} transfer initiated (${payout.netAmount.toString()}) for merchant ${payout.merchantId}, transferId=${result.transferId}`);
    return payout;
  }

  /**
   * Daily sweep — initiates a transfer for every Payout that's eligible
   * (not KYC-blocked, has a net amount, not already initiated). Also
   * exposed on demand via POST /admin/marketplace/initiate-eligible-transfers.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'marketplace-payout-transfer-sweep' })
  async initiateEligibleTransfers(): Promise<{ initiated: number; failed: number }> {
    const payouts = await this.payoutPort.findTransferEligible();
    let initiated = 0;
    let failed = 0;

    for (const payout of payouts) {
      try {
        await this.initiateTransfer(payout.id);
        initiated++;
      } catch (err: unknown) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Payout transfer sweep: failed to initiate transfer for payout ${payout.id}: ${msg}`);
      }
    }

    if (payouts.length > 0) {
      this.logger.log(`Payout transfer sweep: ${initiated} initiated, ${failed} failed, ${payouts.length} eligible`);
    }
    return { initiated, failed };
  }
}
