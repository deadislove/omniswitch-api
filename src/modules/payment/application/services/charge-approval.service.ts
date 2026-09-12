import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ChargeApprovalPort, FindChargeApprovalsFilter } from '../../ports/outbound/charge-approval.port';
import { ChargeApproval } from '../../domain/aggregates/charge-approval.aggregate';
import { Money } from '../../domain/value-objects/money.vo';
import { DelegationService } from './delegation.service';
import { PaymentCheckoutSaga, CheckoutSagaResult } from '../sagas/payment-checkout.saga';
import { buildCheckoutSagaInput } from './build-checkout-saga-input';
import { ChargePaymentDto } from '../dto/charge-payment.dto';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';

/**
 * Charge Approval Service
 * The human-approval hold state `SpendPolicy.requireApprovalAboveAmount`
 * needs — see `ChargeApproval`'s own docblock for the business framing.
 * `PaymentController.charge()` creates the `PENDING` record (spend
 * already reserved against the delegation at that point); this service
 * owns the two decisions an operator can make on it.
 */
@Injectable()
export class ChargeApprovalService {
  private readonly logger = new Logger(ChargeApprovalService.name);

  constructor(
    private readonly chargeApprovalPort: ChargeApprovalPort,
    private readonly delegationService: DelegationService,
    private readonly checkoutSaga: PaymentCheckoutSaga,
  ) {}

  async createPendingApproval(params: {
    paymentId: string;
    delegationId: string;
    merchantId: string;
    amount: Money;
    idempotencyKey: string;
    chargeRequest: Record<string, unknown>;
  }): Promise<ChargeApproval> {
    const approval = ChargeApproval.create({
      id: randomUUID(),
      paymentId: params.paymentId,
      delegationId: params.delegationId,
      merchantId: params.merchantId,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
      chargeRequest: params.chargeRequest,
    });
    await this.chargeApprovalPort.save(approval);
    return approval;
  }

  /**
   * Reads via findByIdOnMaster(), not the ambient replica-routed
   * findById() — this hold state only exists so an operator can act on
   * it right away, so every read here (the general detail view included)
   * has to see a just-written approval immediately. Low enough volume
   * (only above-threshold agent charges create one) that unconditionally
   * forcing master, rather than PayoutService's more surgical per-call-site
   * split, is the right tradeoff.
   */
  async findById(id: string): Promise<ChargeApproval> {
    const approval = await this.chargeApprovalPort.findByIdOnMaster(id);
    if (!approval) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Charge approval ${id} not found`,
        code: 'CHARGE_APPROVAL_NOT_FOUND',
      });
    }
    return approval;
  }

  /** Reads via findManyOnMaster() — see findById()'s docblock for why. */
  async findMany(filter?: FindChargeApprovalsFilter): Promise<ChargeApproval[]> {
    return this.chargeApprovalPort.findManyOnMaster(filter);
  }

  /**
   * Approves and *immediately* executes the deferred charge — there's no
   * further async step after this; the same request that approves also
   * runs `PaymentCheckoutSaga.execute()` and returns its real result.
   * Spend was already reserved against the delegation at creation time
   * (see `PaymentController.charge()`), so this doesn't reserve again —
   * only a denial or a saga failure releases it (see `deny()` and the
   * catch block below).
   */
  async approve(id: string, decidedBy: string): Promise<CheckoutSagaResult> {
    const approval = await this.findById(id);
    if (approval.status !== 'PENDING') {
      throw new ConflictException({
        statusCode: 409,
        error: `Charge approval ${id} is already ${approval.status}`,
        code: 'CHARGE_APPROVAL_ALREADY_DECIDED',
      });
    }

    const now = new Date();
    const marked = await this.chargeApprovalPort.markApproved(id, now, decidedBy);
    if (!marked) {
      throw new ConflictException({
        statusCode: 409,
        error: `Charge approval ${id} was already decided by another request`,
        code: 'CHARGE_APPROVAL_ALREADY_DECIDED',
      });
    }

    const agentPercentOfRemainingMonthlyBudget = await this.deriveAgentPercentOfRemainingMonthlyBudget(
      approval.delegationId,
      approval.amount,
      now,
    );

    let result: CheckoutSagaResult;
    try {
      result = await this.checkoutSaga.execute(
        buildCheckoutSagaInput({
          paymentId: approval.paymentId,
          merchantId: approval.merchantId,
          idempotencyKey: approval.idempotencyKey,
          dto: approval.chargeRequest as unknown as ChargePaymentDto,
          delegationId: approval.delegationId,
          initiatedBy: 'agent',
          agentPercentOfRemainingMonthlyBudget,
        }),
      );
    } catch (err: unknown) {
      await this.delegationService.releaseReservation(approval.delegationId, approval.amount);
      throw err;
    }

    if (result.status === PaymentStatus.FAILED) {
      await this.delegationService.releaseReservation(approval.delegationId, approval.amount);
    }

    this.logger.log(
      `Charge approval ${id} approved by ${decidedBy} — payment ${approval.paymentId} now ${result.status}`,
    );
    return result;
  }

  /**
   * Re-derives `agentPercentOfRemainingMonthlyBudget` from the
   * delegation's *current* state at `approve()` time, closing the gap
   * `CheckoutSagaInput.agentPercentOfRemainingMonthlyBudget`'s own
   * docblock describes: this signal used to be permanently absent on
   * every charge that goes through approval, which — because
   * `ChargeApproval` only exists above `requireApprovalAboveAmount` — is
   * by construction every one of this delegation's largest charges, not
   * a rare edge case.
   *
   * This charge's own `amount` was already reserved against the
   * delegation back at creation time (`PaymentController.charge()`), so
   * `spentThisMonth(now)` at approval time already includes it — backed
   * out below to get "remaining before this specific charge", the same
   * baseline the immediate-execution path measures via the
   * pre-reservation `Delegation` object `reserveSpendOrThrow()` returns.
   * Using *current* spend for everything else the delegation has done
   * since creation (not a frozen creation-time snapshot) is a genuine
   * improvement, not just a stale re-read — an approval sitting for days
   * should reflect what the delegation has actually spent since, not
   * what it looked like when the approval was first created.
   *
   * Returns `undefined` (the previous, honest "signal absent" behavior)
   * if the numbers don't support a meaningful calculation — the calendar
   * month rolled over between creation and approval (so this month's
   * counter no longer reflects this charge's own reservation at all), or
   * the delegation's monthly limit no longer leaves any room once this
   * charge's own reservation is backed out. Both are edge cases a
   * frozen-percentage approach could never have hit either, so this is
   * strictly an improvement, never a regression to the prior behavior.
   */
  private async deriveAgentPercentOfRemainingMonthlyBudget(
    delegationId: string,
    chargeAmount: Money,
    now: Date,
  ): Promise<number | undefined> {
    try {
      const delegation = await this.delegationService.getOrThrow(delegationId);
      const currentSpent = delegation.spentThisMonth(now);
      if (currentSpent.isLessThan(chargeAmount)) {
        return undefined;
      }
      const remainingBeforeThisCharge = delegation.spendPolicy.monthlyLimit.subtract(
        currentSpent.subtract(chargeAmount),
      );
      if (remainingBeforeThisCharge.isZero() || remainingBeforeThisCharge.isLessThan(chargeAmount)) {
        return undefined;
      }
      return (chargeAmount.amount / remainingBeforeThisCharge.amount) * 100;
    } catch (err: unknown) {
      // Best-effort — a signal-derivation failure must never block the
      // approval itself; the risk score just falls back to not having
      // this one signal, same as before this fix existed.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not derive agentPercentOfRemainingMonthlyBudget for delegation ${delegationId}: ${msg}`);
      return undefined;
    }
  }

  /** Denying releases the reservation — the whole point of the hold was that the money was never actually going to move without a human OK. */
  async deny(id: string, decidedBy: string, reason?: string): Promise<ChargeApproval> {
    const approval = await this.findById(id);
    if (approval.status !== 'PENDING') {
      throw new ConflictException({
        statusCode: 409,
        error: `Charge approval ${id} is already ${approval.status}`,
        code: 'CHARGE_APPROVAL_ALREADY_DECIDED',
      });
    }

    const now = new Date();
    const marked = await this.chargeApprovalPort.markDenied(id, now, decidedBy, reason);
    if (!marked) {
      throw new ConflictException({
        statusCode: 409,
        error: `Charge approval ${id} was already decided by another request`,
        code: 'CHARGE_APPROVAL_ALREADY_DECIDED',
      });
    }

    await this.delegationService.releaseReservation(approval.delegationId, approval.amount);
    this.logger.log(
      `Charge approval ${id} denied by ${decidedBy}${reason ? ` (${reason})` : ''} — reservation released`,
    );

    approval.deny(now, decidedBy, reason);
    return approval;
  }
}
