import { Injectable, Logger, NotFoundException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import { BnplOrderPort } from '../../ports/outbound/bnpl-order.port';
import { BnplAdapterPort } from '../../ports/outbound/bnpl-adapter.port';
import { LedgerOutboxPort } from '../../ports/outbound/ledger-outbox.port';
import { LedgerOutboxEvent } from '../../domain/aggregates/ledger-outbox.aggregate';
import { BnplOrder } from '../../domain/aggregates/bnpl-order.aggregate';
import { Money } from '../../domain/value-objects/money.vo';
import { calculateBnplProviderFee } from '../../domain/services/bnpl-fee';
import { MerchantService } from '../../../merchant/merchant.service';

/**
 * BNPL Service
 * Orchestrates a Klarna order's real lifecycle — create (Klarna's own
 * credit decision), capture (the point Klarna actually pays the
 * merchant, booked to the ledger in the same transaction), and refund
 * (routed back through Klarna, never a card-network reversal). See
 * `BnplOrder`'s own docblock for why this is a separate mechanism from
 * `PaymentCheckoutSaga` rather than another branch inside it — no
 * smart-routing/fallback step either, since this reference project
 * models exactly one BNPL provider behind `BnplAdapterPort`.
 */
@Injectable()
export class BnplService {
  private readonly logger = new Logger(BnplService.name);

  constructor(
    private readonly bnplOrderPort: BnplOrderPort,
    private readonly bnplAdapter: BnplAdapterPort,
    private readonly ledgerOutbox: LedgerOutboxPort,
    private readonly merchantService: MerchantService,
  ) {}

  /**
   * Creates and immediately captures a BNPL order — this reference
   * project has no frontend checkout session to pause on between
   * those two real Klarna steps (see `KlarnaBnplAdapter`'s own
   * docblock), so both happen in this one call, same "automatic
   * capture is the default" posture a card charge already has.
   * Idempotent on `idempotencyKey`: a retry returns the
   * already-created order rather than placing a second one.
   */
  async createOrder(params: {
    merchantId: string;
    amount: Money;
    idempotencyKey: string;
    customerId?: string;
    description?: string;
  }): Promise<BnplOrder> {
    const existing = await this.bnplOrderPort.findByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      return existing;
    }

    const merchant = await this.merchantService.findByMerchantId(params.merchantId);
    if (!merchant) {
      throw new NotFoundException({
        statusCode: 404,
        error: `Merchant ${params.merchantId} not found`,
        code: 'MERCHANT_NOT_FOUND',
      });
    }

    const order = BnplOrder.create({
      id: uuidv4(),
      merchantId: params.merchantId,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
      customerId: params.customerId,
      description: params.description,
    });

    const orderResult = await this.bnplAdapter.createOrder({
      bnplOrderId: order.id,
      idempotencyKey: params.idempotencyKey,
      amount: params.amount,
      merchantId: params.merchantId,
      customerId: params.customerId,
      description: params.description,
    });

    if (orderResult.status === 'REJECTED') {
      order.reject(orderResult.errorMessage ?? 'Klarna declined this order');
      await this.bnplOrderPort.save(order);
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: orderResult.errorMessage ?? 'Klarna declined this order',
        code: 'BNPL_ORDER_REJECTED',
      });
    }

    order.authorize(orderResult.providerOrderId);
    await this.bnplOrderPort.save(order);
    this.logger.log(`BNPL order ${order.id} authorized: providerOrderId=${orderResult.providerOrderId}`);

    const captureResult = await this.bnplAdapter.captureOrder({
      providerOrderId: orderResult.providerOrderId,
      amount: params.amount,
      idempotencyKey: uuidv4(),
    });

    if (!captureResult.success) {
      // Authorized but never captured — a real, visible state (Klarna
      // granted credit, but this platform never actually got paid),
      // left for an operator to retry or investigate rather than
      // silently discarded. No ledger entries exist yet, so there's
      // nothing to reverse.
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: captureResult.errorMessage ?? 'Klarna capture failed',
        code: 'BNPL_CAPTURE_FAILED',
      });
    }

    const now = new Date();
    order.capture(captureResult.providerCaptureId!, now);

    const platformFee = params.amount.multiply(merchant.platformFeeBps / 10_000);
    const providerFee = calculateBnplProviderFee(params.amount);
    const outboxEvent = LedgerOutboxEvent.createBnplCaptureEntries({
      id: uuidv4(),
      bnplOrderId: order.id,
      merchantId: params.merchantId,
      amount: params.amount,
      platformFee,
      providerFee,
    });

    await this.bnplOrderPort.save(order);
    await this.ledgerOutbox.saveWithPayment(order.id, outboxEvent);
    this.logger.log(
      `BNPL order ${order.id} captured: amount=${params.amount.toString()} platformFee=${platformFee.toString()} klarnaFee=${providerFee.toString()}`,
    );
    return order;
  }

  async findById(id: string): Promise<BnplOrder | null> {
    return this.bnplOrderPort.findById(id);
  }

  /**
   * Refunds (fully or partially) a captured BNPL order — see
   * `BnplOrder.refund()`'s own docblock for why this never claws back
   * a proportional share of the platform/Klarna fee the way a card
   * refund doesn't either.
   */
  async refundOrder(id: string, amount: Money, reason: string): Promise<BnplOrder> {
    const order = await this.bnplOrderPort.findById(id);
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        error: `BNPL order ${id} not found`,
        code: 'BNPL_ORDER_NOT_FOUND',
      });
    }
    if (order.status !== 'CAPTURED' && order.status !== 'PARTIALLY_REFUNDED') {
      throw new ConflictException({
        statusCode: 409,
        error: `BNPL order ${id} is ${order.status}, cannot refund`,
        code: 'BNPL_ORDER_NOT_REFUNDABLE',
      });
    }

    const refundResult = await this.bnplAdapter.refundOrder({
      providerOrderId: order.providerOrderId!,
      amount,
      reason,
      idempotencyKey: uuidv4(),
    });

    if (!refundResult.success) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: refundResult.errorMessage ?? 'Klarna refund failed',
        code: 'BNPL_REFUND_FAILED',
      });
    }

    const refundId = uuidv4();
    order.refund(refundId, amount, reason, refundResult.providerRefundId!, new Date());

    const outboxEvent = LedgerOutboxEvent.createBnplRefundEntries({
      id: uuidv4(),
      bnplOrderId: order.id,
      merchantId: order.merchantId,
      refundAmount: amount,
    });

    await this.bnplOrderPort.save(order);
    await this.ledgerOutbox.saveWithPayment(order.id, outboxEvent);
    this.logger.log(`BNPL order ${id} refunded ${amount.toString()}: refundId=${refundId}`);
    return order;
  }
}
