import { Injectable, Logger, NotFoundException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { SubscriptionPort, FindSubscriptionsFilter } from '../../ports/outbound/subscription.port';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { Subscription, BillingInterval } from '../../domain/aggregates/subscription.aggregate';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { PaymentCheckoutSaga } from '../sagas/payment-checkout.saga';
import { PlanService } from './plan.service';
import { AcquirerRoutingService } from './acquirer-routing.service';

// 1 initial attempt + 3 retries (see Subscription's RETRY_SCHEDULE_DAYS,
// spread day 1/3/7 after each failure) before giving up — was a flat 3
// (fewer retries, no backoff at all; every attempt fired on the very next
// daily sweep tick). See SubscriptionService's docblock.
const MAX_DUNNING_ATTEMPTS = 4;

// A fixed namespace for uuidv5 — deterministic per-period payment ids are
// derived from `${subscriptionId}:${currentPeriodEnd}` under this
// namespace, not randomly generated. Any fixed UUID works as a v5
// namespace; this one has no meaning beyond "this codebase's constant".
const SUBSCRIPTION_PAYMENT_NAMESPACE = '7c9c9f2e-2c1a-4b8e-9c1a-1f6b6f8b9a10';

/**
 * Subscription Service
 * Owns Subscription lifecycle (create/list/cancel) and the billing sweep
 * that actually produces charges over time — see Subscription aggregate's
 * docblock for why it's a distinct concept from PaymentAggregate.
 *
 * Each billing cycle reuses PaymentCheckoutSaga.execute() wholesale rather
 * than re-implementing charging — a recurring charge should get the same
 * smart routing, risk scoring, ledger booking (including FX/reserve
 * handling), and 3DS-response handling a one-time charge gets, not a
 * parallel, drifting copy of that logic. `binInfo` is omitted (there's no
 * live card entry happening for an off-session renewal); every PSP adapter
 * and SmartRoutingStrategy already treat it as optional.
 *
 * Crash-recovery / double-charge protection: the billing sweep is not
 * wrapped in one DB transaction with the saga's own internal transaction
 * (the saga manages its own; splicing in a second aggregate's write would
 * mean either changing the saga's signature for every caller or a
 * non-atomic two-phase write). Instead each billing attempt for a given
 * subscription+period uses a *deterministic* payment id
 * (`uuidv5(subscriptionId:periodEnd)`) as both the Payment's primary key
 * and its idempotency key. Before charging, this service checks whether
 * that exact id already exists and is SUCCEEDED — if the process crashed
 * between the saga committing its charge and this service advancing the
 * subscription's period, the next sweep tick finds the already-succeeded
 * payment and just advances the period instead of charging again. If it
 * exists but isn't SUCCEEDED (a prior failed attempt for the same period,
 * still PAST_DUE), retrying reuses the same row via the saga's own
 * `save()`-is-an-upsert behavior — same posture as a real dunning retry
 * being "another attempt at the same invoice", not a new one.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly subscriptionPort: SubscriptionPort,
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly checkoutSaga: PaymentCheckoutSaga,
    private readonly planService: PlanService,
    private readonly eventEmitter: EventEmitter2,
    private readonly acquirerRouting: AcquirerRoutingService,
  ) {}

  async createSubscription(params: {
    merchantId: string;
    customerId: string;
    paymentMethodId: string;
    trialDays?: number;
    orderId?: string;
    description?: string;
    /** Either planId, or all three of amount/interval/intervalCount — resolved here, not left to the caller to reconcile. */
    planId?: string;
    amount?: Money;
    interval?: BillingInterval;
    intervalCount?: number;
  }): Promise<Subscription> {
    let amount: Money;
    let interval: BillingInterval;
    let intervalCount: number;
    let planId: string | undefined;

    if (params.planId) {
      const plan = await this.planService.getUsablePlanOrThrow(params.planId, params.merchantId);
      amount = plan.amount;
      interval = plan.interval;
      intervalCount = plan.intervalCount;
      planId = plan.id;
    } else if (params.amount && params.interval && params.intervalCount) {
      amount = params.amount;
      interval = params.interval;
      intervalCount = params.intervalCount;
    } else {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Either planId, or amount/interval/intervalCount together, must be provided',
        code: 'SUBSCRIPTION_MISSING_PRICING',
      });
    }

    if (params.trialDays && params.trialDays > 0) {
      // No charge at all during a trial — see the aggregate's docblock —
      // but the payment method is verified first (see
      // verifyPaymentMethodOrThrow()): a real SetupIntent-style/
      // zero-value-authorization call that confirms the card is real and
      // chargeable without moving any money, so an invalid or
      // already-revoked paymentMethodId is caught now instead of only
      // discovered when the trial tries to convert weeks later.
      await this.verifyPaymentMethodOrThrow(params.merchantId, params.paymentMethodId, amount);

      const subscription = Subscription.startTrial({
        id: uuidv4(),
        merchantId: params.merchantId,
        customerId: params.customerId,
        amount,
        interval,
        intervalCount,
        paymentMethodId: params.paymentMethodId,
        trialDays: params.trialDays,
        orderId: params.orderId,
        description: params.description,
        planId,
      });
      await this.subscriptionPort.save(subscription);
      this.logger.log(`Subscription ${subscription.id} started trial (${params.trialDays}d) for merchant ${params.merchantId}`);
      return subscription;
    }

    // No trial: the first period is charged synchronously, same as a
    // normal checkout — if it fails, no subscription is created at all
    // (matching how a declined one-time charge never creates anything
    // durable either), rather than persisting a subscription that was
    // never actually able to start.
    const subscriptionId = uuidv4();
    const firstPaymentId = uuidv4();
    const result = await this.checkoutSaga.execute({
      paymentId: firstPaymentId,
      idempotencyKey: firstPaymentId,
      amount,
      merchantId: params.merchantId,
      customerId: params.customerId,
      orderId: params.orderId,
      description: params.description ?? `Subscription ${subscriptionId} — first period`,
      paymentMethodId: params.paymentMethodId,
    });

    if (result.status !== PaymentStatus.SUCCEEDED) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Could not start subscription: first charge did not succeed (status=${result.status})`,
        code: 'SUBSCRIPTION_FIRST_CHARGE_FAILED',
      });
    }

    const subscription = Subscription.startActive({
      id: subscriptionId,
      merchantId: params.merchantId,
      customerId: params.customerId,
      amount,
      interval,
      intervalCount,
      paymentMethodId: params.paymentMethodId,
      orderId: params.orderId,
      description: params.description,
      planId,
    });
    await this.subscriptionPort.save(subscription);
    this.logger.log(`Subscription ${subscription.id} started active for merchant ${params.merchantId} (first charge ${firstPaymentId})`);
    return subscription;
  }

  /**
   * Real card verification for a trial signup — routed through the same
   * smart-routing/fallback path a real charge uses
   * (`AcquirerRoutingService.executeWithSmartRouting()`), so a PSP outage
   * falls back to another provider exactly the way a charge would, but a
   * genuine decline (the PSP actually says this card is bad) does not —
   * `executeWithFallback()` only retries on a *thrown* error, and a
   * declined verification is a normal `{ success: false }` return value,
   * not an exception. `amount` is only ever used for routing/risk-scoring
   * purposes here; the PSP call itself never moves it (see
   * PSPVerifyPaymentMethodRequest's docblock).
   */
  private async verifyPaymentMethodOrThrow(merchantId: string, paymentMethodId: string, amount: Money): Promise<void> {
    let verification: { success: boolean; errorMessage?: string };
    try {
      const { result } = await this.acquirerRouting.executeWithSmartRouting(
        { amount, merchantId },
        (adapter) => adapter.verifyPaymentMethod({
          paymentMethodId,
          merchantId,
          currency: amount.currency.code,
          idempotencyKey: uuidv4(),
        }),
      );
      verification = result;
    } catch (err: unknown) {
      // Routing found no PSP at all (e.g. an unsupported currency), or
      // every PSP in the fallback chain threw — same posture as a real
      // charge's routing failure, just surfaced as a clear 422 instead of
      // letting the saga's uncaught-exception path handle it, since
      // there's no payment/subscription record here yet to compensate.
      const msg = err instanceof Error ? err.message : String(err);
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: `Could not verify payment method: ${msg}`,
        code: 'SUBSCRIPTION_PAYMENT_METHOD_VERIFICATION_FAILED',
      });
    }

    if (!verification.success) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: verification.errorMessage ?? 'Payment method could not be verified',
        code: 'SUBSCRIPTION_PAYMENT_METHOD_VERIFICATION_FAILED',
      });
    }
  }

  /**
   * Switches an ACTIVE subscription to a different plan, charging the
   * prorated difference immediately if it's an upgrade (see
   * Subscription.computeUpgradeProration()'s docblock). A downgrade
   * instead issues a *credit* for the unused portion of the current
   * period (Subscription.computeDowngradeCredit()) — applied against a
   * *future* period's charge, not refunded now, since this system has no
   * refund/account-credit primitive to hand it back with immediately. If
   * a proration charge is owed and it fails, the plan change is not
   * applied at all — better a clear failed request than a subscriber
   * silently on the new (more expensive) plan without ever having paid
   * the difference.
   */
  async changePlan(subscriptionId: string, newPlanId: string): Promise<{ subscription: Subscription; prorationCharged?: Money; creditIssued?: Money }> {
    const subscription = await this.getOrThrow(subscriptionId);
    if (subscription.status !== 'ACTIVE') {
      throw new ConflictException({
        statusCode: 409,
        error: `Cannot change plan for a subscription in status ${subscription.status} — only ACTIVE subscriptions can change plans`,
        code: 'SUBSCRIPTION_NOT_ACTIVE',
      });
    }

    const newPlan = await this.planService.getUsablePlanOrThrow(newPlanId, subscription.merchantId);

    let proration: Money | undefined;
    let creditIssued: Money | undefined;
    try {
      proration = subscription.computeUpgradeProration(newPlan.amount, new Date());
      if (!proration) {
        creditIssued = subscription.computeDowngradeCredit(newPlan.amount, new Date());
      }
    } catch (err: unknown) {
      // Currency mismatch — see computeUpgradeProration()'s guard.
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConflictException({ statusCode: 409, error: msg, code: 'PLAN_CURRENCY_MISMATCH' });
    }

    if (proration) {
      const paymentId = uuidv4();
      const result = await this.checkoutSaga.execute({
        paymentId,
        idempotencyKey: paymentId,
        amount: proration,
        merchantId: subscription.merchantId,
        customerId: subscription.customerId,
        orderId: subscription.orderId,
        description: `Subscription ${subscription.id} — proration for switching to plan ${newPlan.name}`,
        paymentMethodId: subscription.paymentMethodId,
      });
      if (result.status !== PaymentStatus.SUCCEEDED) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: `Proration charge did not succeed (status=${result.status}) — plan was not changed`,
          code: 'PRORATION_CHARGE_FAILED',
        });
      }
    }

    subscription.applyPlanChange(
      { planId: newPlan.id, amount: newPlan.amount, interval: newPlan.interval, intervalCount: newPlan.intervalCount },
      new Date(),
    );
    if (creditIssued) {
      subscription.applyDowngradeCredit(creditIssued);
    }
    await this.subscriptionPort.save(subscription);
    this.logger.log(
      `Subscription ${subscription.id} changed to plan ${newPlan.id} (${newPlan.name})` +
      (proration ? `, prorated charge ${proration.toString()}` : creditIssued ? `, issued credit ${creditIssued.toString()} toward a future period` : ', no proration owed'),
    );
    return { subscription, prorationCharged: proration, creditIssued };
  }

  async findById(id: string): Promise<Subscription | null> {
    return this.subscriptionPort.findById(id);
  }

  async findMany(filter?: FindSubscriptionsFilter): Promise<Subscription[]> {
    return this.subscriptionPort.findMany(filter);
  }

  async getOrThrow(id: string): Promise<Subscription> {
    const subscription = await this.subscriptionPort.findById(id);
    if (!subscription) {
      throw new NotFoundException({ statusCode: 404, error: `Subscription ${id} not found`, code: 'SUBSCRIPTION_NOT_FOUND' });
    }
    return subscription;
  }

  async cancel(id: string, atPeriodEnd: boolean): Promise<Subscription> {
    const subscription = await this.getOrThrow(id);
    subscription.requestCancellation(new Date(), !atPeriodEnd);
    await this.subscriptionPort.save(subscription);
    this.logger.log(`Subscription ${id} cancellation requested (atPeriodEnd=${atPeriodEnd}) — now ${subscription.status}`);
    if (subscription.status === 'CANCELED') {
      this.emitCanceledEvent(subscription, 'merchant_requested');
    }
    return subscription;
  }

  private periodPaymentId(subscription: Subscription): string {
    return uuidv5(`${subscription.id}:${subscription.currentPeriodEnd.toISOString()}`, SUBSCRIPTION_PAYMENT_NAMESPACE);
  }

  /**
   * Real event emission, not just a log line — the same "at least
   * something a merchant could subscribe to" posture DisputeService's
   * dispute.created/dispute.resolved events already established. Nothing
   * in this codebase actually subscribes to these yet (no email, no
   * Slack, no paging) — see docs/business-domain/future-directions.md's
   * Recurring Billing section for that still-open gap; this closes "the
   * event isn't even emitted at all", not "someone acts on it".
   */
  private emitPastDueEvent(subscription: Subscription): void {
    this.eventEmitter.emit('subscription.past_due', {
      subscriptionId: subscription.id,
      merchantId: subscription.merchantId,
      customerId: subscription.customerId,
      failedAttempts: subscription.failedAttempts,
      nextRetryAt: subscription.nextRetryAt?.toISOString(),
      declineCode: subscription.lastDeclineCode,
    });
  }

  private emitCanceledEvent(subscription: Subscription, reason: 'dunning_exhausted' | 'hard_decline' | 'period_end_reached' | 'merchant_requested'): void {
    this.eventEmitter.emit('subscription.canceled', {
      subscriptionId: subscription.id,
      merchantId: subscription.merchantId,
      customerId: subscription.customerId,
      reason,
      declineCode: reason === 'hard_decline' ? subscription.lastDeclineCode : undefined,
    });
  }

  /**
   * Daily sweep — every subscription whose current period has ended either
   * gets charged for the next one or, if cancelAtPeriodEnd was set, is
   * finalized as CANCELED instead. Also exposed on demand via
   * POST /admin/subscriptions/run-billing (same dual on-demand + scheduled
   * shape as ReconciliationService/ReserveService), so a test or an
   * impatient operator doesn't have to wait for the schedule.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: 'subscription-billing-sweep' })
  async runBillingSweep(now: Date = new Date()): Promise<{ charged: number; canceled: number; failed: number }> {
    const due = await this.subscriptionPort.findDue(now);
    let charged = 0;
    let canceled = 0;
    let failed = 0;

    for (const subscription of due) {
      const action = subscription.dueAction(now);
      if (action === 'NONE') continue;

      try {
        if (action === 'CANCEL') {
          subscription.finalizeCancellation(now);
          await this.subscriptionPort.save(subscription);
          canceled++;
          this.emitCanceledEvent(subscription, 'period_end_reached');
          continue;
        }

        // action === 'CHARGE'. amountDueThisPeriod, not `amount` directly
        // — a pending downgrade credit (Subscription.applyDowngradeCredit())
        // reduces (or zeroes out) what's actually owed this period.
        const chargeAmount = subscription.amountDueThisPeriod;
        const paymentId = this.periodPaymentId(subscription);

        if (chargeAmount.isZero()) {
          // Fully covered by credit — nothing to actually charge, so no
          // PSP call and no Payment row for this period at all.
          subscription.consumeCredit();
          subscription.recordSuccessfulCharge(now);
          await this.subscriptionPort.save(subscription);
          charged++;
          continue;
        }

        const existing = await this.paymentRepository.findById(paymentId);
        if (existing && existing.status === PaymentStatus.SUCCEEDED) {
          // Crash-recovery: this period was already charged by a prior
          // sweep run that didn't get to advance the subscription
          // afterward — see this service's docblock.
          subscription.consumeCredit();
          subscription.recordSuccessfulCharge(now);
          await this.subscriptionPort.save(subscription);
          charged++;
          continue;
        }

        const result = await this.checkoutSaga.execute({
          paymentId,
          idempotencyKey: paymentId,
          amount: chargeAmount,
          merchantId: subscription.merchantId,
          customerId: subscription.customerId,
          orderId: subscription.orderId,
          description: subscription.description ?? `Subscription ${subscription.id} renewal`,
          paymentMethodId: subscription.paymentMethodId,
        });

        if (result.status === PaymentStatus.SUCCEEDED) {
          subscription.consumeCredit();
          subscription.recordSuccessfulCharge(now);
          await this.subscriptionPort.save(subscription);
          charged++;
        } else {
          subscription.recordFailedCharge(now, MAX_DUNNING_ATTEMPTS, result.errorCode);
          await this.subscriptionPort.save(subscription);
          failed++;
          this.logger.warn(
            `Subscription ${subscription.id} billing attempt failed (status=${result.status}, errorCode=${result.errorCode ?? '(none)'}, attempt ${subscription.failedAttempts}/${MAX_DUNNING_ATTEMPTS}) — now ${subscription.status}`,
          );
          if (subscription.status === 'CANCELED') {
            this.emitCanceledEvent(subscription, subscription.canceledByHardDecline ? 'hard_decline' : 'dunning_exhausted');
          } else {
            this.emitPastDueEvent(subscription);
          }
        }
      } catch (err: unknown) {
        // A thrown error (e.g. routing found no PSP at all) is treated the
        // same as a PSP decline for dunning purposes — don't let one
        // subscription's exception abort the whole sweep, same resilience
        // posture as ReserveService.releaseEligible()'s per-item try/catch.
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Subscription ${subscription.id} billing attempt threw: ${msg}`);
        try {
          subscription.recordFailedCharge(now, MAX_DUNNING_ATTEMPTS);
          await this.subscriptionPort.save(subscription);
          if (subscription.status === 'CANCELED') {
            this.emitCanceledEvent(subscription, 'dunning_exhausted');
          } else {
            this.emitPastDueEvent(subscription);
          }
        } catch (saveErr: unknown) {
          const saveMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
          this.logger.error(`Subscription ${subscription.id}: failed to record the failed charge itself: ${saveMsg}`);
        }
      }
    }

    if (due.length > 0) {
      this.logger.log(`Subscription billing sweep: ${charged} charged, ${canceled} canceled, ${failed} failed, ${due.length} due`);
    }
    return { charged, canceled, failed };
  }
}
