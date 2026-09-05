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

  async findById(id: string): Promise<ChargeApproval> {
    const approval = await this.chargeApprovalPort.findById(id);
    if (!approval) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Charge approval ${id} not found`,
        code: 'CHARGE_APPROVAL_NOT_FOUND',
      });
    }
    return approval;
  }

  async findMany(filter?: FindChargeApprovalsFilter): Promise<ChargeApproval[]> {
    return this.chargeApprovalPort.findMany(filter);
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

    let result: CheckoutSagaResult;
    try {
      result = await this.checkoutSaga.execute(
        buildCheckoutSagaInput({
          paymentId: approval.paymentId,
          merchantId: approval.merchantId,
          idempotencyKey: approval.idempotencyKey,
          dto: approval.chargeRequest as unknown as ChargePaymentDto,
          initiatorMetadata: { delegationId: approval.delegationId, initiatedBy: 'agent' },
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
