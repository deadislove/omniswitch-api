import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import { ReserveHoldPort, FindReserveHoldsFilter } from '../../ports/outbound/reserve-hold.port';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { ReserveHold } from '../../domain/aggregates/reserve-hold.aggregate';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';
import { Money } from '../../domain/value-objects/money.vo';

/**
 * Reserve Service
 * Owns the ReserveHold record's lifecycle — recording a hold at charge
 * time (called by the three ledger-booking call sites right after they get
 * a `reserveHold` back from ChargeLedgerParamsResolverService) and
 * releasing it, either via the scheduled sweep or an operator's manual
 * override (POST /admin/reserves/:id/release, e.g. for a merchant that's
 * since proven low-risk and shouldn't have to wait out the full hold
 * period).
 *
 * Release is always in the currency the hold was withheld in — it does
 * *not* re-run settlement-currency conversion at release time even if the
 * merchant now has one configured. Re-converting would mean either
 * capturing a second FX rate at release time (a real rate the platform
 * would have to actually honor, same open question
 * docs/business-domain/future-directions.md's Cross-Border Settlement
 * section already flags for refunds/lost disputes) or silently reusing the
 * original charge-time rate for a transaction that happens weeks/months
 * later, which is more likely to mislead than help. Released funds credit
 * MERCHANT in the hold's own currency; if that differs from the merchant's
 * current settlement currency, that's a real, still-open gap.
 */
@Injectable()
export class ReserveService {
  private readonly logger = new Logger(ReserveService.name);

  constructor(
    private readonly reserveHoldPort: ReserveHoldPort,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly dataSource: DataSource,
  ) {}

  /** Called in the same DB transaction as the ledger outbox event that funded this hold — see the three ledger-booking call sites. */
  async recordHold(
    params: { paymentId: string; merchantId: string; amount: Money; holdDays: number },
    transactionManager?: unknown,
  ): Promise<ReserveHold> {
    const hold = ReserveHold.create({
      id: uuidv4(),
      paymentId: params.paymentId,
      merchantId: params.merchantId,
      amount: params.amount,
      holdDays: params.holdDays,
    });
    await this.reserveHoldPort.save(hold, transactionManager);
    return hold;
  }

  async findMany(filter?: FindReserveHoldsFilter): Promise<ReserveHold[]> {
    return this.reserveHoldPort.findMany(filter);
  }

  async findById(id: string): Promise<ReserveHold | null> {
    return this.reserveHoldPort.findById(id);
  }

  /**
   * `force: true` is the manual-override path (bypasses the
   * releaseEligibleAt check) — the scheduled sweep below never passes it.
   */
  async release(id: string, options: { force?: boolean } = {}): Promise<ReserveHold> {
    const hold = await this.reserveHoldPort.findById(id);
    if (!hold) {
      throw new NotFoundException({ statusCode: 404, error: `Reserve hold ${id} not found`, code: 'RESERVE_HOLD_NOT_FOUND' });
    }
    if (hold.status !== 'HELD') {
      throw new ConflictException({ statusCode: 409, error: `Reserve hold is already ${hold.status}`, code: 'RESERVE_HOLD_ALREADY_RELEASED' });
    }
    const now = new Date();
    if (!options.force && now < hold.releaseEligibleAt) {
      throw new ConflictException({
        statusCode: 409,
        error: `Reserve hold ${id} is not yet eligible for release (eligible at ${hold.releaseEligibleAt.toISOString()})`,
        code: 'RESERVE_HOLD_NOT_YET_ELIGIBLE',
      });
    }

    let released = false;
    await this.dataSource.transaction(async (manager) => {
      // Conditional on status still being HELD — a concurrent release
      // attempt (manual override racing the sweep) loses this race rather
      // than double-releasing. If it's lost, nothing else in this
      // transaction runs, so no duplicate ledger entry gets written either.
      released = await this.reserveHoldPort.markReleased(id, now, manager);
      if (!released) return;

      const releaseEvent = LedgerOutboxEvent.createReserveReleaseEntries({
        id: uuidv4(),
        paymentId: hold.paymentId,
        merchantId: hold.merchantId,
        amount: hold.amount,
      });
      await this.ledgerOutbox.saveWithPayment(hold.paymentId, releaseEvent, manager);
    });

    if (!released) {
      throw new ConflictException({ statusCode: 409, error: `Reserve hold ${id} lost a race with another release attempt`, code: 'RESERVE_HOLD_ALREADY_RELEASED' });
    }

    // Return the in-memory aggregate, mutated to match what was just
    // committed — not a re-fetch. This app's DataSource routes plain
    // reads to a Postgres replica (see app.module.ts's `replication`
    // config); a findById() here immediately after the transaction commits
    // to master can race the replica's ~1s replication lag (confirmed live:
    // this returned a stale HELD read right after a 200 release response —
    // see docs/technical/infra-verification-status.md's note on the same
    // lag) and report the hold as still HELD despite the write having
    // already succeeded. Same "don't re-fetch after your own write" posture
    // DisputeService.submitEvidence()/MerchantService's update methods
    // already use.
    hold.release(now, options.force ?? false);
    this.logger.log(`Reserve hold ${id} released (${hold.amount.toString()}) for merchant ${hold.merchantId}${options.force ? ' [forced]' : ''}`);
    return hold;
  }

  /**
   * Daily sweep — releases every HELD hold whose releaseEligibleAt has
   * passed. Also exposed on demand via POST /admin/reserves/release-eligible
   * (same dual on-demand + scheduled shape as ReconciliationService), so a
   * test or an impatient operator doesn't have to wait for midnight.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'reserve-release-sweep' })
  async releaseEligible(now: Date = new Date()): Promise<{ released: number; failed: number }> {
    const holds = await this.reserveHoldPort.findReleaseEligible(now);
    let released = 0;
    let failed = 0;

    for (const hold of holds) {
      try {
        await this.release(hold.id, { force: false });
        released++;
      } catch (err: unknown) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Reserve release sweep: failed to release hold ${hold.id}: ${msg}`);
      }
    }

    if (holds.length > 0) {
      this.logger.log(`Reserve release sweep: ${released} released, ${failed} failed, ${holds.length} eligible`);
    }
    return { released, failed };
  }
}
